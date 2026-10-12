// How a run is named on disk - the client's copy of runs.clean() and
// runs.run_folder(), so the record row can show exactly the folder a Record
// will create, and flag a taken number, before anything is sent.

/** A filesystem-safe name, or "" when nothing usable is left (runs.clean). */
export function cleanName(name: string): string {
  return name.trim().replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^[-._]+|[-._]+$/g, "").slice(0, 60);
}

/** run_<NNN>[_<label>] (runs.run_folder). */
export function runFolder(n: number, label: string): string {
  const l = cleanName(label);
  return `run_${String(n).padStart(3, "0")}${l ? `_${l}` : ""}`;
}

/** The experiment as it is spelled on disk, matched case-insensitively the
 *  way Windows folders are; the cleaned name itself for a new experiment. */
export function existingExperiment(experiments: Record<string, number[]> | undefined,
                                   typed: string): string {
  const want = cleanName(typed);
  const low = want.toLowerCase();
  return Object.keys(experiments ?? {}).find((e) => e.toLowerCase() === low) ?? want;
}
