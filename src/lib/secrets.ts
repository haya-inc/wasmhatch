import { normalizeWorkspacePath } from "./workspace";

const PROTECTED_DIRECTORIES = new Set([
  ".aws",
  ".azure",
  ".docker",
  ".gcloud",
  ".git",
  ".kube",
  ".ssh",
  ".terraform"
]);

const PROTECTED_FILES = new Set([
  ".dev.vars",
  ".envrc",
  ".git-credentials",
  ".htpasswd",
  ".netrc",
  ".npmrc",
  ".pypirc",
  "application_default_credentials.json",
  "auth.json",
  "credentials.json",
  "id_dsa",
  "id_ecdsa",
  "id_ed25519",
  "id_rsa",
  "service-account.json"
]);

const PROTECTED_EXTENSIONS = [".jks", ".key", ".keystore", ".p12", ".pem", ".pfx", ".tfstate"];

export function isProtectedAgentPath(input: string): boolean {
  const path = normalizeWorkspacePath(input).toLowerCase();
  const parts = path.split("/");
  const fileName = parts[parts.length - 1];

  if (parts.some((part) => PROTECTED_DIRECTORIES.has(part))) return true;
  if (fileName === ".env" || fileName.startsWith(".env.")) return true;
  if (PROTECTED_FILES.has(fileName)) return true;
  if (PROTECTED_EXTENSIONS.some((extension) => fileName.endsWith(extension))) return true;
  if (/^(?:credentials?|secrets?)(?:\.(?:conf|csv|ini|json|properties|toml|txt|ya?ml))?$/.test(fileName)) return true;
  if (/^service[-_.]?account.*\.json$/.test(fileName)) return true;
  return false;
}
