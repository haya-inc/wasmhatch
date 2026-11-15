import { useCallback, useEffect, useState } from "react";
import { t } from "@lingui/core/macro";
import {
  fetchPortableAgentPackage,
  PORTABLE_AGENT_MEDIA_TYPE,
  readPortableAgentPackage,
  type PortableAgentPackage
} from "../../lib/agent-package";
import type { HatchlingSwarm } from "../../lib/agent-session";
import { downloadBytes } from "../../lib/browser-download";
import { activeLocale } from "../../lib/i18n";
import {
  isRegistryPackageUrl,
  portableFileName,
  publishToRegistry,
  registryBaseUrl,
  registryPackageUrl
} from "../../lib/portable-hatchling";

export interface PortableAgentPreview {
  pkg: PortableAgentPackage;
  source: string;
  action: "hatch" | "publish";
}

export interface PortableAgentFlowController {
  portablePreview: PortableAgentPreview | null;
  dismissPortablePreview: () => void;
  confirmPortablePreview: () => Promise<void>;
  portableBusy: boolean;
  importPortableFile: (file: File) => Promise<void>;
  exportPortable: () => Promise<void>;
  registryLoadUrl: string;
  setRegistryLoadUrl: (url: string) => void;
  loadPortableFromRegistry: () => Promise<void>;
  registryToken: string;
  setRegistryToken: (token: string) => void;
  publishPortable: () => Promise<void>;
}

export function usePortableAgentFlow(
  swarm: HatchlingSwarm,
  onNotice: (text: string, tone?: "info" | "error") => void
): PortableAgentFlowController {
  const [portablePreview, setPortablePreview] = useState<PortableAgentPreview | null>(null);
  const [portableBusy, setPortableBusy] = useState(false);
  const [registryToken, setRegistryToken] = useState("");
  const [registryLoadUrl, setRegistryLoadUrl] = useState("");

  const previewPortableBytes = useCallback(async (bytes: Uint8Array, source: string) => {
    try {
      const pkg = await readPortableAgentPackage(bytes);
      setPortablePreview({ pkg, source, action: "hatch" });
    } catch (error) {
      onNotice(error instanceof Error ? error.message : t`The agent package could not be read.`, "error");
    }
  }, [onNotice]);

  const importPortableFile = useCallback(async (file: File) => {
    await previewPortableBytes(new Uint8Array(await file.arrayBuffer()), file.name);
  }, [previewPortableBytes]);

  const loadPortableFromRegistry = useCallback(async () => {
    const url = registryLoadUrl.trim();
    const base = registryBaseUrl();
    if (!isRegistryPackageUrl(url, base)) {
      onNotice(t`That URL is not on this deployment's registry, so the browser cannot fetch it. Download the .agent file instead and import it here.`, "error");
      return;
    }
    setPortableBusy(true);
    try {
      const pkg = await fetchPortableAgentPackage(url);
      setPortablePreview({ pkg, source: url, action: "hatch" });
      setRegistryLoadUrl("");
    } catch (error) {
      onNotice(error instanceof Error ? error.message : t`The agent package could not be downloaded.`, "error");
    } finally {
      setPortableBusy(false);
    }
  }, [onNotice, registryLoadUrl]);

  const confirmPortablePreview = useCallback(async () => {
    if (!portablePreview || portableBusy) return;
    setPortableBusy(true);
    try {
      if (portablePreview.action === "publish") {
        const base = registryBaseUrl();
        if (!base) throw new Error("No registry is configured for this deployment.");
        const result = await publishToRegistry(base, registryToken.trim(), portablePreview.pkg);
        setPortablePreview(null);
        if (result.quarantined) {
          const until = result.quarantineUntil ? new Date(result.quarantineUntil).toLocaleString(activeLocale()) : "";
          onNotice(t`Accepted into the registry as ${result.publisherId}/${result.agentId} — quarantined until ${until}, then public once its checks pass. Until then only your token can fetch it: ${registryPackageUrl(base, result)}`);
        } else {
          onNotice(t`Published to the registry as ${result.publisherId}/${result.agentId}. Immutable package: ${registryPackageUrl(base, result)}`);
        }
      } else {
        const id = await swarm.hatchFromPackage(portablePreview.pkg);
        swarm.select(id);
        setPortablePreview(null);
        onNotice(t`Hatched “${portablePreview.pkg.manifest.name}” from the package. Its playbook and files are in place; it only has the capabilities shown in the preview.`);
      }
    } catch (error) {
      onNotice(error instanceof Error
        ? error.message
        : portablePreview.action === "publish" ? t`The registry publish failed.` : t`The package could not be hatched.`, "error");
    } finally {
      setPortableBusy(false);
    }
  }, [onNotice, portableBusy, portablePreview, registryToken, swarm]);

  const exportPortable = useCallback(async () => {
    setPortableBusy(true);
    try {
      const pkg = await swarm.exportPortableHatchling(swarm.selectedThreadId);
      downloadBytes(pkg.bytes, portableFileName(pkg.manifest), PORTABLE_AGENT_MEDIA_TYPE);
      onNotice(t`Exported this hatchling as a portable .agent file. It contains its playbook, workspace files, and requested capabilities — never credentials.`);
    } catch (error) {
      onNotice(error instanceof Error ? error.message : t`The hatchling could not be exported.`, "error");
    } finally {
      setPortableBusy(false);
    }
  }, [onNotice, swarm]);

  // Publishing goes through the same preview card: the exact file list and
  // requested capabilities are shown before any upload.
  const publishPortable = useCallback(async () => {
    const base = registryBaseUrl();
    if (!base || !registryToken.trim()) return;
    setPortableBusy(true);
    try {
      const pkg = await swarm.exportPortableHatchling(swarm.selectedThreadId);
      setPortablePreview({ pkg, source: t`this hatchling, before upload`, action: "publish" });
    } catch (error) {
      onNotice(error instanceof Error ? error.message : t`The hatchling could not be exported.`, "error");
    } finally {
      setPortableBusy(false);
    }
  }, [onNotice, registryToken, swarm]);

  // ?agent=<registry package URL> — the shareable try link. The package is
  // fetched and previewed; nothing hatches without the user's click.
  useEffect(() => {
    const param = new URLSearchParams(window.location.search).get("agent");
    if (!param) return;
    const base = registryBaseUrl();
    if (!isRegistryPackageUrl(param, base)) {
      onNotice(t`That URL is not on this deployment's registry, so the browser cannot fetch it. Download the .agent file instead and import it here.`, "error");
      return;
    }
    let cancelled = false;
    void fetchPortableAgentPackage(param)
      .then((pkg) => { if (!cancelled) setPortablePreview({ pkg, source: param, action: "hatch" }); })
      .catch((error: unknown) => {
        if (!cancelled) onNotice(error instanceof Error ? error.message : t`The agent package could not be downloaded.`, "error");
      });
    return () => { cancelled = true; };
    // Runs once per page load for the initial URL.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return {
    portablePreview,
    dismissPortablePreview: () => setPortablePreview(null),
    confirmPortablePreview,
    portableBusy,
    importPortableFile,
    exportPortable,
    registryLoadUrl,
    setRegistryLoadUrl,
    loadPortableFromRegistry,
    registryToken,
    setRegistryToken,
    publishPortable
  };
}
