// Shared types for the login probe.

export interface FormDetection {
  found: boolean;
  actionUrl?: string;
  method?: string;
  usernameField?: string;
  passwordField?: string;
  hiddenFields?: { name: string; value: string }[];
}

export interface ProbeResult {
  id: string;
  target: string;
  username: string;
  password: string;
  verdict: "success" | "fail" | "unknown";
  confidence: "high" | "medium" | "low";
  evidence: string[];
  httpStatus?: number;
  pageTitle?: string;
  finalUrl?: string;
  redirected?: boolean;
  elapsedMs?: number;
  checkedAt: string;
  detection?: FormDetection;
  baseline?: { bytes: number; failKeywords: number; successKeywords: number };
  snapshot?: { bytes: number; path: string };
  snippet?: string;
  cookiesSet?: string[];
  sessionId?: string | null;
  /**
   * Raw cookies submitted with this row (cookie-only rows, or cred rows that
   * included cookies). Kept client-side like the password; lets the console
   * RE-APPLY cookies when the server replay session is gone.
   */
  cookieSource?: string | null;
  error?: string;
}
