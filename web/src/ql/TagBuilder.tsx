import { useMemo, useState } from "react";
import type { QlRun } from "./types";
import { evalTag, suggestPattern, tokenize, type FolderPrefs, type TagDef } from "./model";

/** Make (or edit) a tag from the varying part of the run notes or run folder
 *  names (run_002_10GeV-electrons): click the
 *  piece that changes, check every run's value, fix the misses by hand.
 *  Hand fixes belong to this view only - run files are never modified. */
export function TagBuilder({ runs, initial, overrides, taken, onSave, onDelete, onClose }: {
  runs: QlRun[];
  initial: TagDef | null;
  overrides: FolderPrefs["overrides"];
  taken: string[];
  onSave: (def: TagDef, fixes: Record<string, string>, oldName: string | null) => void;
  onDelete: (name: string) => void;
  onClose: () => void;
}) {
  const sample0 = runs.find((r) => r.note.trim()) ?? runs[0];
  const [source, setSource] = useState<"note" | "folder">(initial?.source ?? "note");
  const [sampleKey, setSampleKey] = useState(sample0?.key ?? "");
  const [picked, setPicked] = useState<number | null>(null);
  const [pattern, setPattern] = useState(initial?.pattern ?? "");
  const [describe, setDescribe] = useState(initial ? "your pattern" : "");
  const [name, setName] = useState(initial?.name ?? "");
  const [kind, setKind] = useState<"number" | "text">(initial?.kind ?? "number");
  const [editPattern, setEditPattern] = useState(false);
  const [fixes, setFixes] = useState<Record<string, string>>(() => {
    const f: Record<string, string> = {};
    if (initial) for (const r of runs) {
      const v = overrides[r.key]?.[initial.name];
      if (v !== undefined) f[r.key] = v;
    }
    return f;
  });

  const sample = runs.find((r) => r.key === sampleKey) ?? sample0;
  const text = (source === "folder" ? sample?.name : sample?.note) ?? "";
  const tokens = useMemo(() => tokenize(text), [text]);
  const def: TagDef = { name: name.trim(), source, pattern, kind };
  let badPattern = false;
  try { new RegExp(pattern, "i"); } catch { badPattern = true; }

  const pick = (i: number) => {
    const s = suggestPattern(tokens, i);
    setPicked(i);
    setPattern(s.pattern);
    setKind(s.kind);
    setDescribe(s.describe);
    if (!name.trim()) setName(s.kind === "number" && /gev/i.test(tokens[i + 1] ?? "") ? "E" : "");
  };

  const rows = runs.filter((r) => r.state !== "unsupported").map((r) => {
    const src = source === "folder" ? r.name : r.note;
    let m: RegExpExecArray | null = null;
    if (pattern && !badPattern) { try { m = new RegExp(pattern, "i").exec(src); } catch { m = null; } }
    const auto = pattern && !badPattern ? evalTag(def, r) : null;
    return { r, src, m, auto };
  });
  const misses = rows.filter((x) => x.auto === null && !(fixes[x.r.key] ?? "").trim()).length;
  const dup = name.trim() !== (initial?.name ?? "") && taken.includes(name.trim());
  const canSave = !!name.trim() && !!pattern && !badPattern && !dup && name.trim() !== "run";

  const hl = (src: string, m: RegExpExecArray | null) => {
    if (!m) return src;
    const val = m[1] ?? m[0];
    const at = m.index + m[0].indexOf(val);
    return <>{src.slice(0, at)}<mark>{val}</mark>{src.slice(at + val.length)}</>;
  };

  return (
    <div className="modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal ql-tagb" role="dialog" aria-label="Tag from run names"
        onKeyDown={(e) => { if (e.key === "Escape") onClose(); }}>
        <div className="ql-row-between">
          <h3>{initial ? `Tag "${initial.name}"` : "New tag from run names"}</h3>
          <div className="ql-seg" role="radiogroup" aria-label="Text to read the tag from">
            <button role="radio" aria-checked={source === "note"} className={source === "note" ? "on" : ""}
              onClick={() => { setSource("note"); setPicked(null); }}>Run note</button>
            <button role="radio" aria-checked={source === "folder"} className={source === "folder" ? "on" : ""}
              onClick={() => { setSource("folder"); setPicked(null); }}>Run folder</button>
          </div>
        </div>

        <div className="ql-step-label">1 · Click the part that changes from run to run</div>
        <div className="ql-tokens">
          <select aria-label="Example run" value={sample?.key ?? ""}
            onChange={(e) => { setSampleKey(e.target.value); setPicked(null); }}>
            {runs.filter((r) => r.state !== "unsupported").map((r) => (
              <option key={r.key} value={r.key}>run {r.number ?? r.key}</option>
            ))}
          </select>
          {tokens.length ? tokens.map((tk, i) => (
            <button key={i} className={"ql-tok" + (picked === i ? " on" : "")} aria-pressed={picked === i}
              onClick={() => pick(i)}>{tk}</button>
          )) : <span className="muted">{source === "folder" ? "This run has no folder name." : "This run has no note."}</span>}
        </div>
        <div className="muted">
          {pattern ? <>Matched by {describe || "the pattern"}. </> : null}
          <button className="linkish" onClick={() => setEditPattern((x) => !x)}>
            {editPattern ? "Hide pattern" : "Edit pattern"}</button>
          {editPattern ? (
            <input className="mono ql-pattern" value={pattern} aria-label="Pattern (regular expression)"
              spellCheck={false} onChange={(e) => { setPattern(e.target.value); setDescribe("your pattern"); }} />
          ) : null}
          {badPattern ? <span className="ql-warn"> Not a valid pattern.</span> : null}
        </div>

        <div className="ql-tagb-fields">
          <label>2 · Tag name<input value={name} onChange={(e) => setName(e.target.value)} /></label>
          <label>Kind
            <select value={kind} onChange={(e) => setKind(e.target.value as "number" | "text")}>
              <option value="number">number</option><option value="text">text</option>
            </select>
          </label>
          {dup ? <span className="ql-warn">A tag with that name exists.</span> : null}
        </div>

        <div className="ql-step-label">3 · Check every run. Fix misses by hand; this changes this view only.</div>
        <div className="ql-tagb-table">
          <table className="ql-table">
            <thead><tr><th>Run</th><th>{source === "folder" ? "Run folder" : "Note"}</th><th>{name.trim() || "value"}</th></tr></thead>
            <tbody>
              {rows.map(({ r, src, m, auto }) => {
                const fixed = fixes[r.key];
                const miss = auto === null && !(fixed ?? "").trim();
                return (
                  <tr key={r.key} className={miss ? "miss" : ""}>
                    <td className="mono">{r.number ?? r.key}</td>
                    <td>{hl(src, m)}</td>
                    <td>
                      <input className="mono" value={fixed ?? auto ?? ""} placeholder="no match"
                        aria-label={`${name || "value"} for run ${r.number ?? r.key}`}
                        onChange={(e) => setFixes((f) => ({ ...f, [r.key]: e.target.value }))} />
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
        {misses ? <div className="ql-warn">{misses} of {rows.length} runs have no value.</div> : null}

        <div className="modal-btns">
          {initial ? <button className="danger" onClick={() => onDelete(initial.name)}>Remove tag</button> : null}
          <span style={{ flex: 1 }} />
          <button onClick={onClose}>Cancel</button>
          <button className="primary" disabled={!canSave}
            onClick={() => {
              // Keep only real fixes: a value equal to what the pattern finds is not one.
              const keep: Record<string, string> = {};
              for (const { r, auto } of rows) {
                const f = fixes[r.key];
                if (f !== undefined && f.trim() !== "" && f !== auto) keep[r.key] = f.trim();
              }
              onSave(def, keep, initial?.name ?? null);
            }}>{initial ? "Save tag" : "Add tag"}</button>
        </div>
      </div>
    </div>
  );
}
