import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { plural, t } from "@lingui/core/macro";
import type { SwarmDeps } from "../../lib/agent-session";
import { GoogleOAuthReauthorizationRequiredError, GoogleOAuthSession, type GoogleOAuthStatus } from "../../lib/google-oauth";
import {
  GOOGLE_PICKER_API_KEY,
  GOOGLE_PICKER_APP_ID,
  googlePickerConfigured,
  openDriveFilePicker,
  type PickedDriveFile
} from "../../lib/google-picker";
import { parseSensitiveScopesFlag, resolveGoogleScopes } from "../../lib/google-scopes";

export const GOOGLE_CLIENT_ID: string = (import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined) ?? "";
// Sensitive Google scopes (opening Sheets/Docs/Slides by URL or ID, and Calendar)
// unlock only when a deployment opts in AFTER Google's Sensitive-scope verification
// clears. Leave VITE_GOOGLE_SENSITIVE_SCOPES unset in production; the default keeps
// the app on the non-sensitive drive.file scope with no unverified-app warning.
export const GOOGLE_SENSITIVE_ENABLED = parseSensitiveScopesFlag(import.meta.env.VITE_GOOGLE_SENSITIVE_SCOPES);

export interface PendingFilePick {
  reason: string;
  resolve: (files: PickedDriveFile[] | null) => void;
}

export interface GoogleConnectorController {
  swarmDeps: SwarmDeps["google"];
  googleStatus: GoogleOAuthStatus;
  googleBusy: boolean;
  connectGoogle: () => Promise<void>;
  disconnectGoogle: () => Promise<void>;
  pickQueue: readonly PendingFilePick[];
  activePick: PendingFilePick | undefined;
  pickerBusy: boolean;
  chooseFilesForPick: () => Promise<void>;
  declinePick: () => void;
}

export function useGoogleConnector(
  onNotice: (text: string, tone?: "info" | "error") => void
): GoogleConnectorController {
  const googleSession = useRef(new GoogleOAuthSession());
  const [googleStatus, setGoogleStatus] = useState<GoogleOAuthStatus>(() => googleSession.current.status());
  const googleStatusRef = useRef(googleStatus);
  googleStatusRef.current = googleStatus;

  const [googleBusy, setGoogleBusy] = useState(false);
  const [pickQueue, setPickQueue] = useState<PendingFilePick[]>([]);
  const [pickerBusy, setPickerBusy] = useState(false);

  const swarmDeps = useMemo<SwarmDeps["google"]>(() => ({
    isConnected: () => googleStatusRef.current.connected,
    sensitiveEnabled: GOOGLE_SENSITIVE_ENABLED,
    // One silent re-grant hides ordinary token expiry from a running turn;
    // if Google wants a gesture again, the visible reconnect flow remains.
    getToken: async (signal) => {
      const provider = googleSession.current.credentialProvider();
      try {
        return await provider.getToken(signal);
      } catch (error) {
        if (!GOOGLE_CLIENT_ID || !(error instanceof GoogleOAuthReauthorizationRequiredError)) throw error;
        const renewed = await googleSession.current
          .authorize(GOOGLE_CLIENT_ID, resolveGoogleScopes(GOOGLE_SENSITIVE_ENABLED), { silent: true })
          .catch(() => null);
        setGoogleStatus(googleSession.current.status());
        if (!renewed?.connected) throw error;
        return provider.getToken(signal);
      }
    },
    ...(googlePickerConfigured() ? {
      requestFilePick: (reason: string, signal?: AbortSignal) => new Promise<PickedDriveFile[] | null>((resolve) => {
        setPickQueue((queue) => [...queue, { reason, resolve }]);
        signal?.addEventListener("abort", () => {
          resolve(null);
          setPickQueue((queue) => queue.filter((entry) => entry.resolve !== resolve));
        }, { once: true });
      })
    } : {})
  }), []);

  // Renew the Google token a minute before it expires (silently, no UI).
  useEffect(() => {
    if (!googleStatus.expiresAt || !GOOGLE_CLIENT_ID) return;
    const expiresAtMs = new Date(googleStatus.expiresAt).getTime();
    let flipTimer: ReturnType<typeof setTimeout> | undefined;
    const renewTimer = setTimeout(() => {
      void googleSession.current
        .authorize(GOOGLE_CLIENT_ID, resolveGoogleScopes(GOOGLE_SENSITIVE_ENABLED), { silent: true })
        .catch(() => null)
        .then(() => {
          setGoogleStatus(googleSession.current.status());
          flipTimer = setTimeout(
            () => setGoogleStatus(googleSession.current.status()),
            Math.max(25, expiresAtMs - Date.now() - 30_000 + 25)
          );
        });
    }, Math.max(1_000, expiresAtMs - Date.now() - 60_000));
    return () => {
      clearTimeout(renewTimer);
      if (flipTimer !== undefined) clearTimeout(flipTimer);
    };
  }, [googleStatus.expiresAt]);

  const connectGoogle = useCallback(async () => {
    if (!GOOGLE_CLIENT_ID || googleBusy) return;
    setGoogleBusy(true);
    try {
      setGoogleStatus(await googleSession.current.authorize(GOOGLE_CLIENT_ID, resolveGoogleScopes(GOOGLE_SENSITIVE_ENABLED)));
      onNotice(GOOGLE_SENSITIVE_ENABLED
        ? t`Google connected. The agent can create Docs, Sheets, and Slides, open ones you share by link, and read or add Calendar events.`
        : t`Google connected. The agent can now create Docs, Sheets, and Slides and edit the ones it creates.`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : t`Google authorization failed.`, "error");
    } finally {
      setGoogleBusy(false);
    }
  }, [googleBusy, onNotice]);

  const disconnectGoogle = useCallback(async () => {
    if (googleBusy) return;
    setGoogleBusy(true);
    try {
      setGoogleStatus(await googleSession.current.revoke());
      onNotice(t`Google access revoked for this tab.`);
    } catch (error) {
      setGoogleStatus(googleSession.current.status());
      onNotice(error instanceof Error ? error.message : t`Google revocation failed.`, "error");
    } finally {
      setGoogleBusy(false);
    }
  }, [googleBusy, onNotice]);

  const activePick = pickQueue[0];

  const declinePick = useCallback(() => {
    activePick?.resolve(null);
    setPickQueue((queue) => queue.slice(1));
  }, [activePick]);

  const chooseFilesForPick = useCallback(async () => {
    if (!activePick || pickerBusy) return;
    setPickerBusy(true);
    try {
      const token = await googleSession.current.credentialProvider().getToken();
      const files = await openDriveFilePicker({
        accessToken: token,
        apiKey: GOOGLE_PICKER_API_KEY,
        appId: GOOGLE_PICKER_APP_ID || undefined,
        title: t`Hand files to WasmHatch`
      });
      activePick.resolve(files);
      setPickQueue((queue) => queue.slice(1));
      onNotice(files?.length
        ? plural(files.length, { one: "Handed # Google file to the agent.", other: "Handed # Google files to the agent." })
        : t`File handover cancelled — nothing was shared.`);
    } catch (error) {
      // Keep the card so the user can retry or decline explicitly.
      onNotice(error instanceof Error ? error.message : t`The Google Picker could not be opened.`, "error");
    } finally {
      setPickerBusy(false);
    }
  }, [activePick, onNotice, pickerBusy]);

  return {
    swarmDeps,
    googleStatus,
    googleBusy,
    connectGoogle,
    disconnectGoogle,
    pickQueue,
    activePick,
    pickerBusy,
    chooseFilesForPick,
    declinePick
  };
}
