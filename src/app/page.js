// initCloudSync is auto-imported by src/app/layout.js — do not re-import here
// (avoid double-init races when both layout and page evaluate).
import { redirect } from "next/navigation";

export default function InitPage() {
  redirect('/dashboard');
}
