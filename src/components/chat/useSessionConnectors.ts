import { useCallback, useMemo, useRef, useState } from "react";
import { t } from "@lingui/core/macro";
import type { SwarmDeps } from "../../lib/agent-session";
import { probeSlackConnectivity } from "../../lib/slack-connect";
import { slackProxyBaseUrl } from "../../lib/slack-tools";
import { isSlackWebhookUrl } from "../../lib/slack-webhook";

export interface SessionConnectorsController {
  slackDeps: NonNullable<SwarmDeps["slack"]>;
  webDeps: NonNullable<SwarmDeps["web"]>;
  slackDraft: string;
  setSlackDraft: (value: string) => void;
  slackConnected: boolean;
  connectSlack: () => void;
  disconnectSlack: () => void;
  slackTokenDraft: string;
  setSlackTokenDraft: (value: string) => void;
  slackTeam: string | null;
  slackTokenBusy: boolean;
  connectSlackToken: () => Promise<void>;
  disconnectSlackToken: () => void;
  tavilyDraft: string;
  setTavilyDraft: (value: string) => void;
  tavilyConnected: boolean;
  connectTavily: () => void;
  disconnectTavily: () => void;
  jinaDraft: string;
  setJinaDraft: (value: string) => void;
  jinaConnected: boolean;
  connectJina: () => void;
  disconnectJina: () => void;
}

/**
 * Memory-only session connectors (Slack Incoming Webhook, Slack bot token,
 * Tavily search fallback, Jina page reader). Drafts live in controlled inputs
 * only until connected; live secrets live exclusively in refs and are never
 * written to Web Storage.
 */
export function useSessionConnectors(
  onNotice: (text: string, tone?: "info" | "error") => void
): SessionConnectorsController {
  const [slackDraft, setSlackDraft] = useState("");
  const [slackConnected, setSlackConnected] = useState(false);
  const slackUrlRef = useRef("");

  const [slackTokenDraft, setSlackTokenDraft] = useState("");
  const [slackTeam, setSlackTeam] = useState<string | null>(null);
  const [slackTokenBusy, setSlackTokenBusy] = useState(false);
  const slackTokenRef = useRef("");

  const [tavilyDraft, setTavilyDraft] = useState("");
  const [tavilyConnected, setTavilyConnected] = useState(false);
  const tavilyKeyRef = useRef("");

  const [jinaDraft, setJinaDraft] = useState("");
  const [jinaConnected, setJinaConnected] = useState(false);
  const jinaKeyRef = useRef("");

  const slackDeps = useMemo<NonNullable<SwarmDeps["slack"]>>(
    () => ({ getWebhookUrl: () => slackUrlRef.current, getToken: () => slackTokenRef.current }),
    []
  );
  const webDeps = useMemo<NonNullable<SwarmDeps["web"]>>(
    () => ({ getTavilyKey: () => tavilyKeyRef.current, getJinaKey: () => jinaKeyRef.current }),
    []
  );

  const connectSlack = useCallback(() => {
    const url = slackDraft.trim();
    if (!isSlackWebhookUrl(url)) {
      onNotice(t`That does not look like a Slack Incoming Webhook URL — it starts with https://hooks.slack.com/services/…`, "error");
      return;
    }
    slackUrlRef.current = url;
    setSlackDraft("");
    setSlackConnected(true);
    onNotice(t`Slack connected. Every hatchling can now post to the webhook's channel.`);
  }, [slackDraft, onNotice]);

  const disconnectSlack = useCallback(() => {
    slackUrlRef.current = "";
    setSlackConnected(false);
    onNotice(t`Slack disconnected.`);
  }, [onNotice]);

  const connectSlackToken = useCallback(async () => {
    const token = slackTokenDraft.trim();
    if (!token) return;
    setSlackTokenBusy(true);
    try {
      const result = await probeSlackConnectivity(token, { baseUrl: slackProxyBaseUrl() });
      if (result.ok) {
        slackTokenRef.current = token;
        setSlackTokenDraft("");
        setSlackTeam(result.team ?? "Slack");
        onNotice(result.team
          ? t`Connected to the Slack workspace “${result.team}”. Channel tools are active for every hatchling.`
          : t`Slack bot token connected. Channel tools are active for every hatchling.`);
      } else if (result.status === "invalid-token") {
        onNotice(t`Slack rejected that token. Reinstall the app in Slack, copy a fresh bot token, and try again.`, "error");
      } else if (result.status === "cors-blocked") {
        onNotice(t`The direct browser route to Slack looks blocked right now. A deployment can bundle the relay described in docs/slack.md and set VITE_SLACK_PROXY_URL.`, "error");
      } else {
        onNotice(t`Slack could not be reached. Check your connection and try again.`, "error");
      }
    } finally {
      setSlackTokenBusy(false);
    }
  }, [slackTokenDraft, onNotice]);

  const disconnectSlackToken = useCallback(() => {
    slackTokenRef.current = "";
    setSlackTeam(null);
    onNotice(t`Slack bot token disconnected.`);
  }, [onNotice]);

  const connectTavily = useCallback(() => {
    const key = tavilyDraft.trim();
    if (!key) return;
    tavilyKeyRef.current = key;
    setTavilyDraft("");
    setTavilyConnected(true);
    onNotice(t`Web search connected. Hatchlings can now use web_search; each search spends your Tavily quota.`);
  }, [tavilyDraft, onNotice]);

  const disconnectTavily = useCallback(() => {
    tavilyKeyRef.current = "";
    setTavilyConnected(false);
    onNotice(t`Web search disconnected.`);
  }, [onNotice]);

  const connectJina = useCallback(() => {
    const key = jinaDraft.trim();
    if (!key) return;
    jinaKeyRef.current = key;
    setJinaDraft("");
    setJinaConnected(true);
    onNotice(t`Page reading connected. Hatchlings can now read a specific page with fetch_page.`);
  }, [jinaDraft, onNotice]);

  const disconnectJina = useCallback(() => {
    jinaKeyRef.current = "";
    setJinaConnected(false);
    onNotice(t`Page reading disconnected.`);
  }, [onNotice]);

  return {
    slackDeps,
    webDeps,
    slackDraft,
    setSlackDraft,
    slackConnected,
    connectSlack,
    disconnectSlack,
    slackTokenDraft,
    setSlackTokenDraft,
    slackTeam,
    slackTokenBusy,
    connectSlackToken,
    disconnectSlackToken,
    tavilyDraft,
    setTavilyDraft,
    tavilyConnected,
    connectTavily,
    disconnectTavily,
    jinaDraft,
    setJinaDraft,
    jinaConnected,
    connectJina,
    disconnectJina
  };
}
