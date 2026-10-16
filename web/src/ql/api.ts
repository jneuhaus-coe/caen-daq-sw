import type { Analysis, QlFolder, QlFolderEntry } from "./types";

async function j<T>(r: Response): Promise<T> {
  if (!r.ok) {
    let detail = "";
    try { detail = (await r.json())?.detail ?? ""; } catch { /* not JSON */ }
    throw new Error(detail || `${r.status} ${r.statusText}`);
  }
  return r.json();
}

export const qlApi = {
  folders: () =>
    fetch("/api/ql/folders").then(j<{ folders: QlFolderEntry[]; data_dir: string }>),
  folder: (path: string) =>
    fetch(`/api/ql/folder?path=${encodeURIComponent(path)}`).then(j<QlFolder>),
  analyse: (req: unknown, signal?: AbortSignal) =>
    fetch("/api/ql/analyse", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify(req), signal,
    }).then(j<Analysis>),
};
