import { parseConversationSharePathname } from "@zcode/shared";

const SAFE_SHARE_CODE = /^[A-Za-z0-9._~-]{1,512}$/u;

/** Accept the share code itself, the share page URL, or M0's import deep link. */
export function parseConversationShareCodeInput(input: string): string | null {
  const value = input.trim();
  if (SAFE_SHARE_CODE.test(value)) return value;

  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }

  let encodedCode: string | null = null;
  if (url.protocol === "zcode:" && url.hostname === "share" && url.pathname === "/import") {
    encodedCode = url.searchParams.get("code");
  } else {
    encodedCode = parseConversationSharePathname(url.pathname)?.rawCode ?? null;
  }
  if (!encodedCode) return null;

  let shareCode: string;
  try {
    shareCode = decodeURIComponent(encodedCode);
  } catch {
    return null;
  }
  return SAFE_SHARE_CODE.test(shareCode) ? shareCode : null;
}
