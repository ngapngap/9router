import { translateResponse, initState } from "../translator/index.js";
import { FORMATS } from "../translator/formats.js";
import { PROVIDERS } from "../config/providers.js";
import { liftReasoningAliases } from "../translator/concerns/reasoning.js";
import { trackPendingRequest, appendRequestLog } from "@/lib/usageDb.js";
import { extractUsage, mergeUsage, hasValidUsage, estimateUsage, logUsage, addBufferToUsage, filterUsageForFormat, COLORS } from "./usageTracking.js";
import { parseSSELine, hasValuableContent, fixInvalidId, formatSSE, ensureStreamToolCallIds, emitStreamErrorFrame } from "./streamHelpers.js";
import { HTTP_STATUS, TRUNCATED_STREAM_MESSAGE } from "../config/runtimeConfig.js";
import { restoreToolNames } from "./opencodeFingerprint.js";
import { getOpenAIResponsesEventName, isOpenAIResponsesTerminalEvent, formatIncompleteOpenAIResponsesStreamFailure } from "./responsesStreamHelpers.js";
import { dbg, isDebugEnabled } from "./debugLog.js";

import { SSE_DONE, SSE_HEADERS, SSE_HEADERS_NO_BUFFER } from "./sseConstants.js";

export { COLORS, formatSSE };
export { SSE_DONE, SSE_HEADERS, SSE_HEADERS_NO_BUFFER };

// sharedEncoder is stateless — safe to share across streams
const sharedEncoder = new TextEncoder();

/**
 * Stream modes
 */
const STREAM_MODE = {
  TRANSLATE: "translate",    // Full translation between formats
  PASSTHROUGH: "passthrough" // No translation, normalize output, extract usage
};

// Upper bound on the deferred response.completed wait: a chat->responses stream
// that saw finish_reason without usage must not hold the client's terminal event
// forever when the upstream stalls with no usage trailer and no [DONE].
const PENDING_COMPLETION_FLUSH_MS = 3000;

// SSE data-only unwrap: a synthesized close emitted by a translator at flush must be
// recognized on the way OUT too, not only when it is parsed on the way in.
const dataPayload = (item) => {
  if (!item || typeof item !== "object") return item;
  if (typeof item.data !== "string" || item.type !== undefined || item.choices !== undefined) return item;
  try {
    return dataPayload(JSON.parse(item.data));
  } catch {
    return item; // not JSON (plain passthrough text): nothing to classify
  }
};

// True when the framed SSE output carries a real finish_reason (not `null`, the usual
// "more deltas coming" placeholder). A synthesized close is exactly this shape too, so it
// is only trusted AFTER the upstream itself was seen ending the turn.
const outputAnnouncesFinish = (output) => {
  for (const line of String(output).split("\n")) {
    if (!line.startsWith("data:")) continue;
    let chunk;
    try { chunk = JSON.parse(line.slice(5).trim()); } catch { continue; }
    if (openAIChunkAnnouncesFinish(chunk)) return true;
  }
  return false;
};

// Same-format Responses events that end a turn. response.failed counts as terminal (it
// already tells the client the turn failed), so it must not be flagged as truncated.
export const RESPONSES_TERMINAL_SOURCE_EVENTS = new Set(["response.completed", "response.done", "response.failed"]);

// Every choice of an OpenAI chunk carries a finish_reason
const openAIChunkAnnouncesFinish = (parsed) =>
  Array.isArray(parsed?.choices) && parsed.choices.length > 0
  && parsed.choices.every((choice) => Boolean(choice?.finish_reason));

// OpenAI delta carrying answer text, thinking, or a tool-call fragment
const openAIDeltaHasBody = (delta) => Boolean(delta) && (
  (typeof delta.content === "string" && delta.content !== "")
  || (typeof delta.reasoning_content === "string" && delta.reasoning_content !== "")
  || (Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0)
);

// An OpenAI chunk whose only news is the finish_reason: translators synthesize exactly
// this at flush to close a turn. Accepting it as the upstream's own terminal frame would
// let a synthesized close masquerade as a normally finished stream.
const isSyntheticFinishChunk = (chunk) => openAIChunkAnnouncesFinish(chunk)
  && chunk.choices.every((choice) => !openAIDeltaHasBody(choice?.delta));

/**
 * Classify one parsed SSE payload (upstream line in translate mode, or a translated
 * chunk on its way out) for truncation detection:
 * - terminal: the payload ends its own turn ([DONE], Anthropic message_delta,
 *   Responses response.completed/failed, a real finish_reason).
 * - content: the payload carries answer text.
 * `synthetic` marks a pure finish_reason announcement; when the client format is not
 * OpenAI it only counts as terminal if the same payload also carries content.
 */
export function classifyStreamTerminal(sourceFormat, targetFormat, parsed) {
  if (!parsed || typeof parsed !== "object") return { terminal: false, content: false, synthetic: false };
  if (parsed.done) return { terminal: true, content: false, synthetic: false };
  if (parsed.type === "message_delta") return { terminal: true, content: false, synthetic: false };
  if (RESPONSES_TERMINAL_SOURCE_EVENTS.has(parsed.type)) return { terminal: true, content: false, synthetic: false };

  const claudeText = parsed.type === "content_block_delta" && typeof parsed.delta?.text === "string" && parsed.delta.text !== "";
  const geminiText = Array.isArray(parsed.candidates?.[0]?.content?.parts)
    && parsed.candidates[0].content.parts.some((part) => part?.thought !== true && typeof part?.text === "string" && part.text !== "");
  const content = Boolean(parsed.delta?.text) || Boolean(parsed.choices?.[0]?.delta?.content?.length)
    || claudeText || geminiText;

  if (openAIChunkAnnouncesFinish(parsed)) {
    const synthetic = isSyntheticFinishChunk(parsed);
    return { terminal: targetFormat === FORMATS.OPENAI || !synthetic, content, synthetic };
  }
  return { terminal: false, content, synthetic: false };
}

/**
 * Create unified SSE transform stream
 * @param {object} options
 * @param {string} options.mode - Stream mode: translate, passthrough
 * @param {string} options.targetFormat - Provider format (for translate mode)
 * @param {string} options.sourceFormat - Client format (for translate mode)
 * @param {string} options.provider - Provider name
 * @param {object} options.reqLogger - Request logger instance
 * @param {string} options.model - Model name
 * @param {string} options.connectionId - Connection ID for usage tracking
 * @param {object} options.body - Request body (for input token estimation)
 * @param {function} options.onStreamComplete - Callback when stream completes (content, usage)
 * @param {string} options.apiKey - API key for usage tracking
 */
export function createSSEStream(options = {}) {
  const {
    mode = STREAM_MODE.TRANSLATE,
    targetFormat: requestedTargetFormat,
    sourceFormat,
    provider = null,
    reqLogger = null,
    toolNameMap = null,
    customToolNames = null,
    model = null,
    connectionId = null,
    body = null,
    onStreamComplete = null,
    apiKey = null,
    credentials = null,
    onTruncated = null,
    // "OpenAI chat chunks relayed byte-for-byte to an OpenAI-shaped client" (see
    // createPassthroughStreamWithLogger). Only that lane synthesizes the [DONE] itself;
    // a translate-mode stream must not read an upstream [DONE] as a client-visible close.
    relayTerminatesOnDone = false
  } = options;

  // Same-format streams (createPassthroughStreamWithLogger) do not pass targetFormat: the
  // provider's own format IS the client format, which is what the client-side rules below
  // (terminal frames, truncation, Responses framing) key on.
  const targetFormat = requestedTargetFormat ?? sourceFormat;

  let buffer = "";
  let usage = null;

  // Tool-call ids already sent to the client, keyed by the tool-call index.
  // A late fragment that opens a NEW index without an id must not reach the
  // client as-is: strict OpenAI-compatible SDKs abort the turn on a
  // tool_call without a string id (#4992).
  const seenToolCallIds = new Map();

  // Per-stream decoder with stream:true to correctly handle multi-byte chars split across chunks
  const decoder = new TextDecoder("utf-8", { fatal: false });

  const state = mode === STREAM_MODE.TRANSLATE
    ? { ...initState(sourceFormat), provider, toolNameMap, customToolNames: new Set(customToolNames || []), model, sessionId: credentials?._clientSessionId || null,
        // Which upstream format this stream came from. A response translator can be
        // reached either directly (target === its registered source) or as the second
        // hop of a pivot, and on the terminal null chunk the pivot drops it — so a
        // translator that defers closing events until flush needs to know which case
        // it is in. Absent/undefined means "unknown", i.e. do not defer.
        targetFormat }
    : null;

  let totalContentLength = 0;
  let accumulatedContent = "";
  let accumulatedThinking = "";
  let ttftAt = null;
  let sseLineCount = 0;
  let sseEmittedCount = 0;
  const eventTypeCounts = {};

  // Track Responses API event framing for same-format passthrough (codex)
  let currentOpenAIResponsesEvent = null;
  let openAIResponsesTerminalSeen = false;
  let openAIResponsesDoneSent = false;
  let streamDoneSent = false;  // track duplicate [DONE] across transform + flush
  let finalized = false;
  let completionFlushTimer = null;
  // Truncation tracking: did the upstream ever send its terminal event, and did the
  // translators already close the turn themselves (Responses emits response.incomplete)?
  let upstreamTerminalSeen = false;
  let translatorClosed = false;
  // Did the client itself already receive a closing frame (a finish_reason line on the
  // same-format relay, or a translator-framed one)? Then the turn is closed on the wire
  // and an error frame after it would be noise.
  let clientCloseSeen = false;
  // Same-format relay: the upstream's [DONE] will itself be forwarded to the client as its
  // closing frame, so it counts as an upstream close — but only once the relay really is
  // what the client gets (flush() forwards the sentinel for this lane).
  let relayedCloseSeen = false;

  // Record one SSE payload for truncation detection.
  //   upstream: an event parsed from the provider stream; closes the turn when it is a
  //             real terminal frame, and clears the flag if the translator already
  //             closed the turn itself (Responses passthrough emits response.incomplete).
  //   outgoing: a translated chunk about to be framed for the client; a translator-made
  //             finish_reason counts here, since the client got a proper close.
  const noteStreamEvent = (role, payload, clientFormat) => {
    const verdict = classifyStreamTerminal(sourceFormat, clientFormat, dataPayload(payload));
    if (role === "upstream") {
      if (verdict.terminal && !verdict.synthetic) upstreamTerminalSeen = true;
      if (payload?.done && relayTerminatesOnDone) relayedCloseSeen = true;
      if (payload?.type && RESPONSES_TERMINAL_SOURCE_EVENTS.has(payload.type)) upstreamTerminalSeen = true;
    } else if (verdict.terminal) {
      // A translator-framed finish_reason sends a close to the client, so a fabricated
      // close at flush can no longer be told apart from it.
      translatorClosed = true;
      clientCloseSeen = true;
    }
  };

  // A 200 stream that ended with answer text but no terminal frame from the upstream is
  // truncated. The translators close such a turn with a synthesized finish (stop /
  // end_turn), which would hand the client a complete-looking answer cut mid-sentence,
  // so the close is replaced by a terminal error frame instead. Only OpenAI, Claude and
  // Responses are covered; other client formats keep their existing close.
  const TRUNCATION_ERROR_FORMATS = new Set([FORMATS.OPENAI, FORMATS.CLAUDE]);
  const emitTruncationError = (controller) => {
    emitStreamErrorFrame(controller, HTTP_STATUS.BAD_GATEWAY, TRUNCATED_STREAM_MESSAGE, sourceFormat);
    sseEmittedCount++;
  };

  // A 200 stream that ended with answer text but whose closing frame the upstream never
  // sent: the translators close such a turn with a synthesized finish (stop / end_turn),
  // which would hand the client a complete-looking answer cut mid-sentence.
  const isTruncated = () => TRUNCATION_ERROR_FORMATS.has(sourceFormat)
    && accumulatedContent.length > 0
    && !upstreamTerminalSeen
    && !clientCloseSeen
    && !relayedCloseSeen;

  // Lane quirk: upstream streams thinking under the OpenRouter aliases
  // (`reasoning` / `reasoning_details[]`) instead of reasoning_content — OpenCode
  // Free's MiMo route does. Lift it on every passthrough delta so OpenAI-shaped
  // clients, the thinking accumulation below and usage accounting see the text.
  const liftAliases = mode === STREAM_MODE.PASSTHROUGH && !!PROVIDERS[provider]?.quirks?.reasoningAliasFields;

  // Usage/logging tail, callable from transform() as well as flush(): a client that
  // closes right after the terminal event cancels the reader, and flush() never runs.
  const finalizeStream = () => {
    if (completionFlushTimer) { clearTimeout(completionFlushTimer); completionFlushTimer = null; }
    if (headTimer) { clearTimeout(headTimer); headTimer = null; }
    // Whatever is still held for the commit decision goes out with the close.
    releaseHead(activeController);
    if (finalized) return;
    finalized = true;

    const isPassthrough = mode === STREAM_MODE.PASSTHROUGH;
    let finalUsage = isPassthrough ? usage : state?.usage;

    if (!hasValidUsage(finalUsage) && totalContentLength > 0) {
      finalUsage = estimateUsage(body, totalContentLength, isPassthrough ? FORMATS.OPENAI : sourceFormat);
      if (isPassthrough) usage = finalUsage; else state.usage = finalUsage;
    }

    if (hasValidUsage(finalUsage)) {
      logUsage(isPassthrough ? provider : (state?.provider || targetFormat), finalUsage, model, connectionId, apiKey);
    } else {
      appendRequestLog({ model, provider, connectionId, tokens: null, status: "200 OK" }).catch(() => { });
    }

    if (onStreamComplete) {
      onStreamComplete({
        content: accumulatedContent,
        thinking: accumulatedThinking
      }, finalUsage, ttftAt);
    }

    if (onTruncated) {
      // Same rule as the error frame: the upstream never finished, but the client did get
      // answer text. A reasoning-only cut is not reported (nothing was rendered as answer).
      const truncated = !upstreamTerminalSeen && accumulatedContent.length > 0;
      try { onTruncated({ truncated, content: accumulatedContent }); } catch { /* best-effort */ }
    }
  };

  // A chat upstream ends a turn with a finish_reason that the translator may hold back
  // pending a usage trailer; a Responses upstream ends it with a terminal event.
  const responseDeferralHoldsTerminal = (source) =>
    source === FORMATS.OPENAI_RESPONSES || source === FORMATS.OPENAI;

  // A Responses turn whose finish_reason is waiting for a usage trailer.
  const openAIResponsesDeferred = (turnState) =>
    Boolean(turnState?.completionPending) && !turnState?.completedSent;

  // Chat upstream -> Responses client: the translator may hold response.completed back
  // until the terminal chunk, so this lane closes the turn itself (see emitTranslatedClose).
  const responseFormatDeferred = () =>
    targetFormat === FORMATS.OPENAI && sourceFormat === FORMATS.OPENAI_RESPONSES;

  // The deferred terminal event as SSE bytes, or null when nothing was owed.
  const flushPendingCompletionBytes = () => {
    const completed = translateResponse(targetFormat, sourceFormat, null, state);
    if (!completed?.length) return null;
    return completed
      .filter((item) => item !== null && item !== undefined)
      .map((item) => formatSSE(item, sourceFormat))
      .join("");
  };

  // Combo failover peeks a candidate's stream for content before committing to it
  // (services/emptyFailover.js peekStreamForContent). A 200 stream that dies before any
  // answer text would otherwise be committed by its first frame — a client-role frame, or
  // [DONE] — and then judged empty. So on this lane nothing is released until the first
  // chunk that proves the turn produced something; the terminal frames themselves are
  // never held back. A diagnostic frame before any hold is the only way out.
  let released = false;
  const holdUntilCommit = () => false;
  const commitCheckpoint = (output) => {
    released = true;
    const head = encoderHeadOutput();
    if (head) reqLogger?.appendConvertedChunk?.(head);
    return (head ? head : "") + (output || "");
  };
  const HEAD_DELAYED_CHUNK_MS = 2500;
  const headBuffer = [];
  let headTimer = null;
  const encoderHeadOutput = () => {
    if (!headBuffer.length) return "";
    const head = headBuffer.splice(0).join("");
    return head.endsWith("\n") ? head : `${head}\n`;
  };
  // Fail-open: a provider that keeps the connection open without ever finishing (thinking
  // longer than HEAD_DELAYED_CHUNK_MS before its first event) must still stream.
  const armHeadTimer = (controller) => {
    if (headTimer) return;
    headTimer = setTimeout(() => {
      headTimer = null;
      if (released) return;
      try { controller.enqueue(sharedEncoder.encode(commitCheckpoint(""))); } catch { /* controller already closed */ }
    }, HEAD_DELAYED_CHUNK_MS);
  };
  // Close the held head as soon as it shows answer text or a tool call. Until then only a
  // [DONE] would ever be released here, and a tool-call turn has no content delta at all —
  // waiting for the close would hand the client a lone [DONE].
  const releaseHeadIfAnswered = (controller) => {
    if (released || !holdUntilCommit() || !headBuffer.length) return;
    if (!headBuffer.join("\n").match(/"(content|tool_calls)":/)) return;
    releaseHead(controller);
  };

  const releaseHead = (controller) => {
    if (headTimer) { clearTimeout(headTimer); headTimer = null; }
    if (!controller) return;
    const head = encoderHeadOutput();
    if (!head) return;
    released = true;
    reqLogger?.appendConvertedChunk?.(head);
    controller.enqueue(sharedEncoder.encode(head));
    sseEmittedCount++;
    // A released head may hold the turn's terminal frame: the buffered close counts exactly
    // as if that frame had been relayed live, so truncation bookkeeping stays honest.
    for (const line of head.split("\n")) {
      const trimmedLine = line.trim();
      if (!trimmedLine) continue;
      if (trimmedLine.startsWith("event:")) {
        currentOpenAIResponsesEvent = trimmedLine.slice(6).trim();
      } else if (trimmedLine.startsWith("data:")) {
        const payload = dataPayload(trimmedLine.slice(5).trim());
        if (!payload || payload.done) continue;
        const isOpenAIResponsesStream = sourceFormat === FORMATS.OPENAI_RESPONSES;
        const eventName = isOpenAIResponsesStream
          ? getOpenAIResponsesEventName(currentOpenAIResponsesEvent, payload)
          : null;
        noteStreamEvent("upstream", payload, sourceFormat);
        if (isOpenAIResponsesStream && isOpenAIResponsesTerminalEvent(eventName, payload)) {
          openAIResponsesTerminalSeen = true;
          clientCloseSeen = true;
        }
        if (mode === STREAM_MODE.PASSTHROUGH && payload.choices?.[0]?.finish_reason) clientCloseSeen = true;
        currentOpenAIResponsesEvent = null;
      }
    }
  };

  // finalizeStream() runs both from the transform loop and from the completion watchdog
  // timer, where neither variable holds a per-line value. Declared here so every closure
  // above sees them; the transform/flush bodies assign the live values.
  let activeController = null;
  let relayed = null;

  // Answer text (or a tool call) in a client-format payload: the turn produced output.
  const hasAnswerText = (item, format) => {
    if (format === FORMATS.OPENAI) {
      const choice = item?.choices?.[0];
      const delta = choice?.delta || choice?.message || {};
      if (typeof delta.content === "string" && delta.content !== "") return true;
      return Array.isArray(delta.tool_calls) && delta.tool_calls.length > 0;
    }
    return hasValuableContent(item, format);
  };
  const relayedHasBody = (relayed) => Array.isArray(relayed?.choices)
    && relayed.choices.some((choice) => hasAnswerText({ choices: [choice] }, FORMATS.OPENAI));

  const enqueueOutput = (controller, output, { commit = false } = {}) => {
    if (!output) return false;
    if (!released && holdUntilCommit()) {
      if (!commit) {
        headBuffer.push(output);
        armHeadTimer(controller);
        releaseHeadIfAnswered(controller);
        return true;
      }
      output = commitCheckpoint(output);
    }
    reqLogger?.appendConvertedChunk?.(output);
    controller.enqueue(sharedEncoder.encode(output));
    sseEmittedCount++;
    return true;
  };

  // Close the relay for a client that is not a Responses client: [DONE] once.
  const closeClientRelay = (controller) => {
    releaseHead(controller);
    if (!openAIResponsesDoneSent && !streamDoneSent) {
      if (enqueueOutput(controller, SSE_DONE, { commit: true })) {
        openAIResponsesDoneSent = true;
        streamDoneSent = true;
      }
    }
  };

  // Close a Responses turn for the client: the terminal event exactly once — the one the
  // upstream/translator already produced, or a synthesized response.failed — then [DONE].
  const closeOpenAIResponsesTurn = (controller) => {
    releaseHead(controller);
    if (!openAIResponsesTerminalSeen) {
      if (enqueueOutput(controller, formatIncompleteOpenAIResponsesStreamFailure(), { commit: true })) {
        openAIResponsesTerminalSeen = true;
      }
    }
    closeClientRelay(controller);
  };

  // Flush whatever the commit hold still holds (a head released into a closed controller
  // would be lost), then give the client its close when the [DONE] handler did not.
  const closeOpenAILane = (controller) => {
    // Gemini-family clients (Antigravity, Vertex, Gemini) reject the sentinel with a 400.
    const isGeminiFamily = provider === "antigravity" || provider === "gemini" || provider === "vertex";
    releaseHead(controller);
    if (!isGeminiFamily) closeClientRelay(controller);
    finalizeStream(true);
  };

  // The translator is handed its terminal null chunk: a deferred response.completed is
  // released now, and a turn the upstream never closed is reported as response.failed
  // instead of a silent close.
  const emitTranslatedClose = (controller) => {
    enqueueOutput(controller, flushPendingCompletionBytes(), { commit: true });
    if (state?.completedSent === true) openAIResponsesTerminalSeen = true;
    closeOpenAIResponsesTurn(controller);
  };

  // Emit the deferred terminal event now — at [DONE], or when the watchdog below
  // gives up on a usage trailer that never arrives.
  const flushPendingCompletion = (controller) => {
    if (responseFormatDeferred()) {
      emitTranslatedClose(controller);
    } else {
      for (const item of translateResponse(targetFormat, sourceFormat, null, state) || []) {
        enqueueOutput(controller, item === null || item === undefined ? null : formatSSE(item, sourceFormat));
      }
      if (targetFormat === FORMATS.OPENAI_RESPONSES) closeOpenAIResponsesTurn(controller);
    }
    finalizeStream(true);
  };

  return new TransformStream({
    transform(chunk, controller) {
      activeController = controller;
      if (!ttftAt) ttftAt = Date.now();
      const text = decoder.decode(chunk, { stream: true });
      buffer += text;
      reqLogger?.appendProviderChunk?.(text);

      const lines = buffer.split("\n");
      buffer = lines.pop() || "";

      for (const line of lines) {
        const trimmed = line.trim();
        if (isDebugEnabled && trimmed) {
          sseLineCount++;
          if (trimmed.startsWith("event:")) {
            const evt = trimmed.slice(6).trim();
            eventTypeCounts[evt] = (eventTypeCounts[evt] || 0) + 1;
          }
        }

        // Capture Responses API event name to preserve framing in same-format passthrough
        if (mode === STREAM_MODE.TRANSLATE && targetFormat === FORMATS.OPENAI_RESPONSES && trimmed.startsWith("event:")) {
          currentOpenAIResponsesEvent = trimmed.slice(6).trim();
        }

        // Passthrough mode: normalize and forward
        if (mode === STREAM_MODE.PASSTHROUGH) {
          // A frame's blank separator line is not a frame: it is merged into the held head and
          // released with it, never emitted on its own ahead of the answer it belongs to.
          if (!trimmed && !released && holdUntilCommit()) {
            headBuffer.push("\n");
            continue;
          }
          let output;
          let injectedUsage = false;
          let responsesTerminal = false;
          // Whether this line carried a real finish_reason. Terminal-only chunks (no content,
          // no reasoning) are never forwarded, so the close is recorded as it parses.
          let closeSeen = false;
          // The parsed chunk, for the commit decision at the relay point below (the inner
          // `parsed` is scoped to the try block).
          let relayed = null;

          if (trimmed.startsWith("data:") && trimmed.slice(5).trim() !== "[DONE]") {
            try {
              let parsed = JSON.parse(trimmed.slice(5).trim());
              relayed = parsed;
              // A terminal-only chunk (no content, no reasoning) is not forwarded below, but
              // it is the upstream closing the turn: record it as soon as it parses, so no
              // `continue` below can skip past it.
              if (mode === STREAM_MODE.PASSTHROUGH && typeof parsed.choices?.[0]?.finish_reason === "string") closeSeen = true;

              const idFixed = fixInvalidId(parsed);

              // A fragment that opens a new tool-call index without an id breaks
              // strict OpenAI-compatible clients. Mint/reuse one before the
              // chunk reaches the client.
              const toolCallIdFixed = ensureStreamToolCallIds(parsed, seenToolCallIds);

              // The fingerprint pass renames a colliding caller tool to an alias
              // (read -> read_client). On this path nothing restored it, so the
              // client received a call to a tool it never declared and answered
              // "Model tried to call unavailable tool 'read_client'" (#4986).
              let toolNameRestored = false;
              if (toolNameMap?.size) {
                const restored = restoreToolNames(parsed, toolNameMap);
                if (restored !== parsed) {
                  parsed = restored;
                  toolNameRestored = true;
                }
              }

              // Ensure OpenAI-required fields are present on streaming chunks (Letta compat)
              let fieldsInjected = false;
              if (parsed.choices !== undefined) {
                if (!parsed.object) { parsed.object = "chat.completion.chunk"; fieldsInjected = true; }
                if (!parsed.created) { parsed.created = Math.floor(Date.now() / 1000); fieldsInjected = true; }
              }

              // Strip Azure-specific non-standard fields from streaming chunks
              if (parsed.prompt_filter_results !== undefined) {
                delete parsed.prompt_filter_results;
                fieldsInjected = true;
              }
              if (parsed?.choices) {
                for (const choice of parsed.choices) {
                  if (choice.content_filter_results !== undefined) {
                    delete choice.content_filter_results;
                    fieldsInjected = true;
                  }
                }
              }

              // Alias lanes: expose thinking as reasoning_content (additive) before
              // the valuable-content check, so reasoning-only chunks survive.
              if (liftAliases && parsed?.choices) {
                for (const choice of parsed.choices) {
                  if (choice?.delta) {
                    const lifted = liftReasoningAliases(choice.delta);
                    if (lifted !== choice.delta) {
                      choice.delta = lifted;
                      fieldsInjected = true;
                    }
                  }
                }
              }

              // Strip empty tool_calls arrays that break AI SDK reasoning tracking.
              // Some providers (e.g. CodeBuddy CN) include `"tool_calls": []` in
              // every streaming delta. @ai-sdk/openai-compatible checks
              // `delta.tool_calls != null` — an empty array passes this check,
              // causing premature `reasoning-end` on every chunk.
              if (parsed?.choices) {
                for (const choice of parsed.choices) {
                  if (choice.delta?.tool_calls && Array.isArray(choice.delta.tool_calls) && choice.delta.tool_calls.length === 0) {
                    delete choice.delta.tool_calls;
                    fieldsInjected = true;
                  }
                }
              }

              if (!hasValuableContent(parsed, FORMATS.OPENAI)) {
                continue;
              }

              const delta = parsed.choices?.[0]?.delta;
              const content = delta?.content;
              const reasoning = delta?.reasoning_content;
              if (content && typeof content === "string") {
                totalContentLength += content.length;
                accumulatedContent += content;
              }
              if (reasoning && typeof reasoning === "string") {
                totalContentLength += reasoning.length;
                accumulatedThinking += reasoning;
              }

              const extracted = extractUsage(parsed);
              if (extracted) {
                usage = mergeUsage(usage, extracted);
              }

              responsesTerminal = isOpenAIResponsesTerminalEvent(currentOpenAIResponsesEvent, parsed);
              // The Responses relay below re-emits every event itself; it only gets here for
              // deltas, because hasValuableContent() skips a terminal event (no choices, no
              // text). Track the terminal state here so a close is not mistaken for a cut.
              // (Same-format Responses passthrough runs in TRANSLATE mode: the relay block
              // below owns this flag, and `isOpenAIResponsesStream` is declared after this
              // try block — naming it here threw and the catch swallowed the whole chunk.)
              if (responsesTerminal) openAIResponsesTerminalSeen = true;

              const isFinishChunk = parsed.choices?.[0]?.finish_reason;
              if (isFinishChunk && !hasValidUsage(parsed.usage)) {
                const estimated = estimateUsage(body, totalContentLength, FORMATS.OPENAI);
                parsed.usage = filterUsageForFormat(estimated, FORMATS.OPENAI);
                output = `data: ${JSON.stringify(parsed)}\n`;
                usage = estimated;
                injectedUsage = true;
              } else if (isFinishChunk && usage) {
                const buffered = addBufferToUsage(usage);
                parsed.usage = filterUsageForFormat(buffered, FORMATS.OPENAI);
                output = `data: ${JSON.stringify(parsed)}\n`;
                injectedUsage = true;
              } else if (idFixed || fieldsInjected || toolCallIdFixed || toolNameRestored) {
                output = `data: ${JSON.stringify(parsed)}\n`;
                injectedUsage = true;
              }
            } catch (err) {
              // Skip non-JSON data lines silently — don't forward garbage to clients.
              // Upstream providers sometimes return plain-text errors (HTML, rate-limit
              // messages) in the SSE stream that would break downstream JSON decoders.
              continue;
            }
          }

          if (!injectedUsage) {
            if (line.startsWith("data:") && !line.startsWith("data: ")) {
              output = "data: " + line.slice(5) + "\n";
            } else {
              output = line + "\n";
            }
          }

          // Same-format streaming (OpenAI client ← OpenAI upstream) is relayed line by line,
          // never through the translator, so this lane is the only place a real upstream
          // close shows up — and it is recorded before forwarding.
          if (closeSeen) {
            upstreamTerminalSeen = true;
            clientCloseSeen = true;
          }

          enqueueOutput(controller, output, { commit: relayedHasBody(relayed) });
          // Responses clients (codex CLI) close on response.completed instead of [DONE]
          if (responsesTerminal) {
            openAIResponsesTerminalSeen = true;
            finalizeStream();
          }
          continue;
        }

        // Translate mode
        if (!trimmed) {
          // The blank separator between SSE frames travels with its own frame instead of
          // being streamed as an empty line of its own (see the passthrough block above).
          if (!released && holdUntilCommit()) headBuffer.push("\n");
          continue;
        }

        const parsed = parseSSELine(trimmed, targetFormat);
        if (!parsed) {
          continue;
        }
        noteStreamEvent("upstream", parsed, targetFormat);
        // Same-format streaming (OpenAI client ← OpenAI upstream) is relayed one line at a
        // time below, never through the translator, so the relay is where a real close shows.
        if (mode === STREAM_MODE.PASSTHROUGH && parsed.choices?.[0]?.finish_reason) clientCloseSeen = true;

        // Responses API same-format passthrough: preserve event framing + track terminal state
        const isOpenAIResponsesStream = targetFormat === FORMATS.OPENAI_RESPONSES;
        const keepsOpenAIResponsesFormat = isOpenAIResponsesStream && sourceFormat === FORMATS.OPENAI_RESPONSES;
        const openAIResponsesEventName = isOpenAIResponsesStream
          ? getOpenAIResponsesEventName(currentOpenAIResponsesEvent, parsed)
          : null;

        if (isOpenAIResponsesStream && isOpenAIResponsesTerminalEvent(openAIResponsesEventName, parsed)) {
          openAIResponsesTerminalSeen = true;
        }

        // For Ollama: done=true is the final chunk with finish_reason/usage, must translate
        // For other formats: done=true is the [DONE] sentinel, skip
        if (parsed && parsed.done && targetFormat !== FORMATS.OLLAMA) {
          // Responses clients never see [DONE]: their turn is closed by response.completed
          // (or a synthesized response.failed) plus the sentinel emitted at flush. Re-emitting
          // the sentinel here would duplicate it. For a same-format relay the upstream's own
          // terminal event already ended the turn, so nothing is owed.
          if (keepsOpenAIResponsesFormat) {
            // Responses clients never see [DONE]: with no terminal event in hand the
            // sentinel means the turn was cut, so it is reported as response.failed right
            // here — before the sentinel, which is then emitted once by the flush.
            closeOpenAIResponsesTurn(controller);
            streamDoneSent = true;
            continue;
          }
          // An upstream [DONE] is a real close of the turn (noteStreamEvent: not synthetic),
          // unlike the finish_reason-only frame a translator may fabricate at flush.
          noteStreamEvent("upstream", parsed, targetFormat);
          if (responseFormatDeferred()) {
            // The deferred response.completed is released at [DONE], not at transport EOF:
            // a chat upstream can send the sentinel and keep the connection open. The
            // sentinel is emitted right after that terminal event.
            streamDoneSent = true;
            flushPendingCompletion(controller);
            return;
          }
          // The client's own close: whatever the commit hold still holds goes out first,
          // followed by [DONE] when this lane owes one (Gemini-family clients reject it).
          closeOpenAILane(controller);
          return;
        }

        // Claude format - content
        if (parsed.delta?.text) {
          totalContentLength += parsed.delta.text.length;
          accumulatedContent += parsed.delta.text;
        }
        // Claude format - thinking
        if (parsed.delta?.thinking) {
          totalContentLength += parsed.delta.thinking.length;
          accumulatedThinking += parsed.delta.thinking;
        }
        
        // OpenAI format - content
        if (parsed.choices?.[0]?.delta?.content) {
          totalContentLength += parsed.choices[0].delta.content.length;
          accumulatedContent += parsed.choices[0].delta.content;
        }
        // OpenAI format - reasoning
        if (parsed.choices?.[0]?.delta?.reasoning_content) {
          totalContentLength += parsed.choices[0].delta.reasoning_content.length;
          accumulatedThinking += parsed.choices[0].delta.reasoning_content;
        }
        
        // Gemini format
        if (parsed.candidates?.[0]?.content?.parts) {
          for (const part of parsed.candidates[0].content.parts) {
            if (part.text && typeof part.text === "string") {
              totalContentLength += part.text.length;
              // Check if this is thinking content
              if (part.thought === true) {
                accumulatedThinking += part.text;
              } else {
                accumulatedContent += part.text;
              }
            }
          }
        }

        // Extract usage
        const extracted = extractUsage(parsed);
        if (extracted) state.usage = mergeUsage(state.usage, extracted); // Keep original usage for logging

        // Responses same-format relay: re-emit with the original event framing. The turn
        // ends under the client's own event when the upstream alone closed it, and under a
        // translated terminal event otherwise — so the loop returns after it.
        const relayOpenAIResponsesEvent = keepsOpenAIResponsesFormat && Boolean(openAIResponsesEventName);
        if (relayOpenAIResponsesEvent) {
          const output = formatSSE({ event: openAIResponsesEventName, data: parsed }, sourceFormat);
          enqueueOutput(controller, output, { commit: true });
          currentOpenAIResponsesEvent = null;
          sseEmittedCount++;
          if (openAIResponsesTerminalSeen) {
            // Responses clients (codex) close on response.completed instead of [DONE]
            finalizeStream();
            return;
          }
        }

        currentOpenAIResponsesEvent = null;

        // Translate: targetFormat -> openai -> sourceFormat
        const translated = translateResponse(targetFormat, sourceFormat, parsed, state);

        // Log OpenAI intermediate chunks (if available)
        if (translated?._openaiIntermediate) {
          for (const item of translated._openaiIntermediate) {
            const openaiOutput = formatSSE(item, FORMATS.OPENAI);
            reqLogger?.appendOpenAIChunk?.(openaiOutput);
          }
        }

        // An event the same-format relay just forwarded must not be translated as well.
        const outgoing = relayOpenAIResponsesEvent ? null : translated;
        if (outgoing?.length > 0) {
          for (const item of outgoing) {
            if (item === null || item === undefined) continue;
            // Filter empty chunks
            if (!hasValuableContent(item, sourceFormat)) {
              continue; // Skip this empty chunk
            }

            // Inject estimated usage if finish chunk has no valid usage
            const isFinishChunk = item.type === "message_delta" || item.choices?.[0]?.finish_reason;
            if (state.finishReason && isFinishChunk && !hasValidUsage(item.usage) && totalContentLength > 0) {
              const estimated = estimateUsage(body, totalContentLength, sourceFormat);
              item.usage = filterUsageForFormat(estimated, sourceFormat); // Filter + already has buffer
              state.usage = estimated;
            } else if (state.finishReason && isFinishChunk && state.usage) {
              // Add buffer and filter usage for client (but keep original in state.usage for logging)
              const buffered = addBufferToUsage(state.usage);
              item.usage = filterUsageForFormat(buffered, sourceFormat);
            }

            const output = formatSSE(item, sourceFormat);
            const truncationFormat = TRUNCATION_ERROR_FORMATS.has(sourceFormat);
            // A translator that framed a real finish_reason for the client closed the
            // turn already (or the same translation path is set to close the turn without
            // the upstream ever ending it, having consumed the upstream's own close — see
            // classifyStreamTerminal's `synthetic`): the flush must not read as truncation.
            if (truncationFormat && (outputAnnouncesFinish(output) || state.finishReason)) {
              translatorClosed = true;
              clientCloseSeen = true;
            }
            enqueueOutput(controller, output, { commit: hasAnswerText(item, sourceFormat) });
            noteStreamEvent("outgoing", item, sourceFormat);
          }
        }

        // The completion deferral can outlive the upstream: a broken chat upstream
        // may stall after finish_reason with no usage trailer and no [DONE], holding
        // the connection open. Bound the wait so the client still gets a terminal event.
        const wantsFlushedCompletion = responseDeferralHoldsTerminal(sourceFormat);
        if (targetFormat === FORMATS.OPENAI && wantsFlushedCompletion &&
            state?.completionPending && !state?.completedSent) {
          completionFlushTimer = setTimeout(() => {
            completionFlushTimer = null;
            if (state?.completedSent) return;
            try { flushPendingCompletion(controller); } catch { /* controller already closed */ }
          }, PENDING_COMPLETION_FLUSH_MS);
        }
      }
    },

    flush(controller) {
      activeController = controller;
      const evtSummary = Object.entries(eventTypeCounts).map(([k, v]) => `${k}=${v}`).join(",") || "none";
      dbg("SSE", `flush | provider=${provider} | model=${model} | recvLines=${sseLineCount} | emitted=${sseEmittedCount} | events=[${evtSummary}]`);
      trackPendingRequest(model, provider, connectionId, false);
      try {
        const remaining = decoder.decode();
        if (remaining) buffer += remaining;

        const truncated = isTruncated();

        // A Responses client closes on its terminal event, so a synthesized response.failed
        // may only ever reach a same-format Responses stream (whose events are forwarded
        // verbatim). A translated stream closes with the translator's own finish frame:
        // framing a Responses event into it would hand the client a terminal it cannot parse.
        const keepsResponsesFormat = targetFormat === FORMATS.OPENAI_RESPONSES
          && sourceFormat === FORMATS.OPENAI_RESPONSES;

        if (mode === STREAM_MODE.PASSTHROUGH) {
          if (buffer) {
            let output = buffer;
            if (buffer.startsWith("data:") && !buffer.startsWith("data: ")) {
              output = "data: " + buffer.slice(5);
            }
            enqueueOutput(controller, output);
          }

          // IMPORTANT: In passthrough mode we still must terminate the SSE stream.
          // Some clients (e.g. OpenClaw) expect the OpenAI-style sentinel:
          //   data: [DONE]\n\n
          // Without it they can hang until timeout and trigger failover.
          // Gemini-family clients (Antigravity, Vertex, Gemini) reject this sentinel with 400 syntax errors.
          const isGeminiFamily = provider === "antigravity" || provider === "gemini" || provider === "vertex";
          // Same-format streams are closed with [DONE] here, which looks like a complete
          // answer: when the upstream never closed the turn itself, replace that close with
          // the error frame so the client knows the answer it got was cut.
          if (isTruncated()) {
            emitTruncationError(controller);
            finalizeStream();
            return;
          }
          if (!streamDoneSent && !isGeminiFamily) {
            enqueueOutput(controller, SSE_DONE, { commit: true });
          }

          finalizeStream();
          return;
        }

        if (buffer.trim()) {
          // Same parse as the transform loop: without targetFormat this only
          // accepts "data: " lines, so an NDJSON provider (Ollama) lost whatever
          // arrived without its closing newline.
          const parsed = parseSSELine(buffer.trim(), targetFormat);
          // parseSSELine turns the SSE sentinel "data: [DONE]" into { done: true },
          // which must not be translated. An Ollama chunk also carries done:true,
          // but it is the real final chunk — it holds finish_reason and the token
          // counts — so it has to go through.
          const isDoneSentinel = parsed?.done && targetFormat !== FORMATS.OLLAMA;
          if (parsed && !isDoneSentinel) {
            // Same accumulation the transform loop does, so finalizeStream() can
            // log a tail chunk's tokens instead of falling back to null.
            const extracted = extractUsage(parsed);
            if (extracted) state.usage = mergeUsage(state.usage, extracted);

            const translated = translateResponse(targetFormat, sourceFormat, parsed, state);

            if (translated?._openaiIntermediate) {
              for (const item of translated._openaiIntermediate) {
                const openaiOutput = formatSSE(item, FORMATS.OPENAI);
                reqLogger?.appendOpenAIChunk?.(openaiOutput);
              }
            }

            if (translated?.length > 0) {
              for (const item of translated) {
                if (item === null || item === undefined) continue;
                const output = formatSSE(item, sourceFormat);
                reqLogger?.appendConvertedChunk?.(output);
                controller.enqueue(sharedEncoder.encode(output));
              }
            }
          }
        }

        // Chat -> Responses: the turn always closes with a terminal event for the client.
        // A deferred response.completed is released here (the generic flush pass below
        // only consumes _openaiIntermediate, so an event it returns would be lost); a turn
        // the upstream never closed gets response.failed. Both are followed by [DONE].
        if (responseFormatDeferred()) {
          emitTranslatedClose(controller);
          finalizeStream();
          return;
        }

        const flushed = translateResponse(targetFormat, sourceFormat, null, state);

        if (flushed?._openaiIntermediate) {
          for (const item of flushed._openaiIntermediate) {
            const openaiOutput = formatSSE(item, FORMATS.OPENAI);
            reqLogger?.appendOpenAIChunk?.(openaiOutput);
          }
        }

        // Same-format Responses relay: the client's terminal event is the upstream's own,
        // which the transform loop already forwarded — only the [DONE] sentinel is owed.
        if (keepsResponsesFormat) {
          closeOpenAIResponsesTurn(controller);
          finalizeStream();
          return;
        }

        // Truncation runs BEFORE the flush pass: once translateResponse(null) has run the
        // translator has closed the turn, so a fabricated close could no longer be told
        // apart from a real one.
        if (truncated) {
          // Skip the closing flush entirely: it would frame a stop/end_turn for a partial
          // answer. The error frame is the terminal event instead.
          emitTruncationError(controller);
          finalizeStream();
          return;
        }

        finalizeStream();
      } catch (error) {
        console.log("Error in flush:", error);
        finalizeStream();
      }
    }
  });
}

export function createSSETransformStreamWithLogger(targetFormat, sourceFormat, provider = null, reqLogger = null, toolNameMap = null, model = null, connectionId = null, body = null, onStreamComplete = null, apiKey = null, customToolNames = null, credentials = null, onTruncated = null) {
  return createSSEStream({
    mode: STREAM_MODE.TRANSLATE,
    targetFormat,
    sourceFormat,
    provider,
    reqLogger,
    toolNameMap,
    customToolNames,
    model,
    connectionId,
    body,
    onStreamComplete,
    apiKey,
    credentials,
    onTruncated
  });
}

// The client format of a same-format stream (no translator): a Responses-API provider
// (codex) streams Responses events, every other passthrough upstream speaks OpenAI SSE.
function providerSourceFormat(provider) {
  return PROVIDERS[provider]?.format === FORMATS.OPENAI_RESPONSES ? FORMATS.OPENAI_RESPONSES : FORMATS.OPENAI;
}

export function createPassthroughStreamWithLogger(provider = null, reqLogger = null, model = null, connectionId = null, body = null, onStreamComplete = null, apiKey = null, toolNameMap = null, onTruncated = null) {
  // Same-format streaming needs no translator, so the client format is the provider's own.
  return createSSEStream({
    mode: STREAM_MODE.PASSTHROUGH,
    provider,
    reqLogger,
    toolNameMap,
    model,
    connectionId,
    body,
    onStreamComplete,
    apiKey,
    sourceFormat: providerSourceFormat(provider),
    onTruncated,
    relayTerminatesOnDone: providerSourceFormat(provider) === FORMATS.OPENAI
  });
}
