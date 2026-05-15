// src/lib/device.ts
//
// Generates a persistent per-browser device ID stored in localStorage,
// plus user-agent parsing to give devices human-readable names.

const DEVICE_ID_KEY = "tp_device_id";

/**
 * Returns a stable UUID for this browser/device. Generated on first call
 * and persisted to localStorage. Clears if user clears site data.
 */
export function getOrCreateDeviceId(): string {
  if (typeof window === "undefined") return "";
  try {
    const existing = window.localStorage.getItem(DEVICE_ID_KEY);
    if (existing) return existing;

    // Use crypto.randomUUID where available, fallback to a random hex string
    const id =
      typeof crypto !== "undefined" && "randomUUID" in crypto
        ? crypto.randomUUID()
        : `dev_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;

    window.localStorage.setItem(DEVICE_ID_KEY, id);
    return id;
  } catch {
    // localStorage disabled (private browsing, etc.) — fall back to a session-only ID
    return `ephemeral_${Math.random().toString(36).slice(2)}`;
  }
}

/**
 * Returns the device ID without creating one if it doesn't exist.
 * Used on logout — we don't want to materialize a new ID if the user
 * is logging out from a fresh tab they never registered.
 */
export function getDeviceId(): string | null {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage.getItem(DEVICE_ID_KEY);
  } catch {
    return null;
  }
}

// ─── User-agent parsing ─────────────────────────────────────────────────────

export interface DeviceInfo {
  deviceId: string;
  deviceType: "mobile" | "tablet" | "desktop";
  deviceName: string;
  browser: string;
  os: string;
}

export function getDeviceInfo(): DeviceInfo {
  const deviceId = getOrCreateDeviceId();

  if (typeof window === "undefined" || typeof navigator === "undefined") {
    return {
      deviceId,
      deviceType: "desktop",
      deviceName: "Unknown device",
      browser: "Unknown",
      os: "Unknown",
    };
  }

  const ua = navigator.userAgent || "";

  // OS detection — order matters (iPhone before Mac, since iOS includes "Mac")
  let os = "Unknown";
  if (/iPhone|iPad|iPod/.test(ua)) os = "iOS";
  else if (/Android/.test(ua)) os = "Android";
  else if (/Windows NT/.test(ua)) os = "Windows";
  else if (/Mac OS X/.test(ua)) os = "macOS";
  else if (/Linux/.test(ua)) os = "Linux";

  // Browser detection — also order-sensitive (Edge before Chrome, etc.)
  let browser = "Unknown";
  if (/Edg\//.test(ua)) browser = "Edge";
  else if (/OPR\//.test(ua) || /Opera/.test(ua)) browser = "Opera";
  else if (/Firefox\//.test(ua)) browser = "Firefox";
  else if (/Chrome\//.test(ua)) browser = "Chrome";
  else if (/Safari\//.test(ua)) browser = "Safari";

  // Device type
  let deviceType: "mobile" | "tablet" | "desktop" = "desktop";
  if (/iPad/.test(ua) || (os === "Android" && !/Mobile/.test(ua))) {
    deviceType = "tablet";
  } else if (/Mobile|iPhone|Android/.test(ua)) {
    deviceType = "mobile";
  }

  // Human-readable name, e.g. "Chrome on macOS" or "Safari on iPhone"
  const deviceName = `${browser} on ${os}`;

  return { deviceId, deviceType, deviceName, browser, os };
}
