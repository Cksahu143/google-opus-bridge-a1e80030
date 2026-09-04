import { useEffect, useMemo, useState } from "react";
import { Link } from "@tanstack/react-router";
import { RefreshCw, Send, Trash2, Plus, BookOpen, ShieldCheck } from "lucide-react";
import { useSession } from "@/lib/useSession";

type Notebook = { id?: string; notebook_id?: string; title?: string; name?: string };
type Source = { id?: string; source_id?: string; title?: string; name?: string; url?: string };

type ApiResult = { ok: boolean; data?: unknown; error?: string };

async function callApi(token: string, action: string, body: Record<string, unknown> = {}) {
  const response = await fetch("/api/notebooklm", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${token}` },
    body: JSON.stringify({ action, ...body }),
  });
  const result = (await response.json()) as ApiResult;
  if (!response.ok || !result.ok) throw new Error(result.error || "NotebookLM request failed");
  return result.data;
}

function idOf(value: Notebook | Source) {
  return value.id || value.notebook_id || value.source_id || "";
}

function titleOf(value: Notebook | Source) {
  return value.title || value.name || "Untitled";
}

export default function NotebookLMPage() {
  const { session, loading: sessionLoading } = useSession();
  const [notebooks, setNotebooks] = useState<Notebook[]>([]);
  const [selectedId, setSelectedId] = useState("");
  const [sources, setSources] = useState<Source[]>([]);
  const [question, setQuestion] = useState("");
  const [answer, setAnswer] = useState("");
  const [sourceUrl, setSourceUrl] = useState("");
  const [sourceText, setSourceText] = useState("");
  const [sourceTitle, setSourceTitle] = useState("");
  const [newTitle, setNewTitle] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  const token = session?.access_token || "";
  const selected = useMemo(() => notebooks.find((n) => idOf(n) === selectedId), [notebooks, selectedId]);

  async function refresh() {
    if (!token) return;
    setBusy(true); setError("");
    try {
      const data = (await fetch("/api/notebooklm?action=list", { headers: { Authorization: `Bearer ${token}` } }).then(async (r) => {
        const j = (await r.json()) as ApiResult;
        if (!r.ok || !j.ok) throw new Error(j.error || "Unable to list notebooks");
        return j.data;
      })) as Notebook[];
      const list = Array.isArray(data) ? data : [];
      setNotebooks(list);
      if (!selectedId && list[0]) setSelectedId(idOf(list[0]));
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to load notebooks"); }
    finally { setBusy(false); }
  }

  async function refreshSources(notebookId = selectedId) {
    if (!token || !notebookId) return;
    try {
      const data = await callApi(token, "sources", { notebookId });
      setSources(Array.isArray(data) ? data : []);
    } catch (e) { setError(e instanceof Error ? e.message : "Unable to load sources"); }
  }

  useEffect(() => { void refresh(); }, [token]);
  useEffect(() => { void refreshSources(); }, [token, selectedId]);

  async function ask() {
    if (!question.trim() || !selectedId || !token) return;
    setBusy(true); setError(""); setAnswer("");
    try {
      const data = await callApi(token, "ask", { notebookId: selectedId, question: question.trim() });
      setAnswer(typeof data === "string" ? data : JSON.stringify(data, null, 2));
      setQuestion("");
    } catch (e) { setError(e instanceof Error ? e.message : "Question failed"); }
    finally { setBusy(false); }
  }

  async function createNotebook() {
    if (!newTitle.trim() || !token) return;
    setBusy(true); setError("");
    try { await callApi(token, "create", { title: newTitle.trim() }); setNewTitle(""); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "Create failed"); }
    finally { setBusy(false); }
  }

  async function deleteNotebook() {
    if (!selectedId || !token || !window.confirm("Delete this NotebookLM notebook permanently?")) return;
    setBusy(true); setError("");
    try { await callApi(token, "delete", { notebookId: selectedId }); setSelectedId(""); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "Delete failed"); }
    finally { setBusy(false); }
  }

  async function addUrl() {
    if (!sourceUrl.trim() || !selectedId || !token) return;
    setBusy(true); setError("");
    try { await callApi(token, "add-url", { notebookId: selectedId, url: sourceUrl.trim(), wait: true }); setSourceUrl(""); await refreshSources(); }
    catch (e) { setError(e instanceof Error ? e.message : "Source add failed"); }
    finally { setBusy(false); }
  }

  async function addText() {
    if (!sourceText.trim() || !selectedId || !token) return;
    setBusy(true); setError("");
    try { await callApi(token, "add-text", { notebookId: selectedId, text: sourceText.trim(), title: sourceTitle.trim() || "Web note", wait: true }); setSourceText(""); setSourceTitle(""); await refreshSources(); }
    catch (e) { setError(e instanceof Error ? e.message : "Source add failed"); }
    finally { setBusy(false); }
  }

  async function deleteSource(sourceId: string) {
    if (!sourceId || !token || !window.confirm("Delete this source permanently?")) return;
    setBusy(true); setError("");
    try { await callApi(token, "delete-source", { sourceId }); await refreshSources(); }
    catch (e) { setError(e instanceof Error ? e.message : "Source delete failed"); }
    finally { setBusy(false); }
  }

  if (sessionLoading) return <main className="min-h-screen p-6">Loading…</main>;
  if (!session) return <main className="min-h-screen p-6"><h1 className="text-2xl font-semibold">NotebookLM Bridge</h1><p className="mt-2">Sign in to the Bridge first.</p><Link className="mt-4 inline-block underline" to="/">Return home</Link></main>;

  return (
    <main className="min-h-screen bg-background p-4 md:p-8">
      <div className="mx-auto max-w-6xl space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-4">
          <div><div className="flex items-center gap-2"><BookOpen className="h-6 w-6" /><h1 className="text-2xl font-semibold">NotebookLM Bridge</h1></div><p className="text-sm text-muted-foreground">Web access powered by notebooklm-py.</p></div>
          <button className="inline-flex items-center gap-2 rounded-lg border px-3 py-2" onClick={() => void refresh()} disabled={busy}><RefreshCw className="h-4 w-4" /> Refresh</button>
        </header>

        <section className="rounded-xl border p-4">
          <div className="flex items-center gap-2 text-sm"><ShieldCheck className="h-4 w-4" /> Server-side NotebookLM credentials; they never enter this page.</div>
          {error && <p className="mt-3 rounded-lg border border-destructive/40 p-3 text-sm text-destructive">{error}</p>}
        </section>

        <div className="grid gap-6 lg:grid-cols-[280px_1fr]">
          <aside className="rounded-xl border p-4">
            <h2 className="font-medium">Notebooks</h2>
            <div className="mt-3 flex gap-2"><input className="min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm" placeholder="New notebook" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} onKeyDown={(e) => e.key === "Enter" && void createNotebook()} /><button className="rounded-lg border p-2" onClick={() => void createNotebook()} disabled={busy}><Plus className="h-4 w-4" /></button></div>
            <div className="mt-4 space-y-1">{notebooks.map((n) => <button key={idOf(n)} onClick={() => setSelectedId(idOf(n))} className={`w-full rounded-lg px-3 py-2 text-left text-sm ${selectedId === idOf(n) ? "bg-muted font-medium" : "hover:bg-muted/60"}`}>{titleOf(n)}</button>)}</div>
          </aside>

          <section className="space-y-6">
            <div className="rounded-xl border p-5">
              <div className="flex flex-wrap items-center justify-between gap-3"><div><h2 className="font-semibold">{selected ? titleOf(selected) : "Select a notebook"}</h2><p className="text-xs text-muted-foreground">{selectedId || "No notebook selected"}</p></div>{selectedId && <button className="inline-flex items-center gap-2 rounded-lg border px-3 py-2 text-sm text-destructive" onClick={() => void deleteNotebook()} disabled={busy}><Trash2 className="h-4 w-4" /> Delete</button>}</div>
              <div className="mt-5 flex gap-2"><input className="min-w-0 flex-1 rounded-lg border px-3 py-3" placeholder="Ask your notebook…" value={question} onChange={(e) => setQuestion(e.target.value)} onKeyDown={(e) => e.key === "Enter" && !e.shiftKey && void ask()} disabled={!selectedId} /><button className="rounded-lg border px-4" onClick={() => void ask()} disabled={busy || !selectedId || !question.trim()}><Send className="h-4 w-4" /></button></div>
              {answer && <pre className="mt-5 whitespace-pre-wrap rounded-lg bg-muted p-4 text-sm">{answer}</pre>}
            </div>

            {selectedId && <div className="grid gap-6 md:grid-cols-2">
              <div className="rounded-xl border p-5"><h3 className="font-semibold">Add URL source</h3><div className="mt-3 flex gap-2"><input className="min-w-0 flex-1 rounded-lg border px-3 py-2 text-sm" placeholder="https://…" value={sourceUrl} onChange={(e) => setSourceUrl(e.target.value)} /><button className="rounded-lg border px-3" onClick={() => void addUrl()} disabled={busy || !sourceUrl.trim()}>Add</button></div></div>
              <div className="rounded-xl border p-5"><h3 className="font-semibold">Add text source</h3><input className="mt-3 w-full rounded-lg border px-3 py-2 text-sm" placeholder="Title" value={sourceTitle} onChange={(e) => setSourceTitle(e.target.value)} /><textarea className="mt-2 min-h-24 w-full rounded-lg border px-3 py-2 text-sm" placeholder="Paste notes…" value={sourceText} onChange={(e) => setSourceText(e.target.value)} /><button className="mt-2 rounded-lg border px-3 py-2 text-sm" onClick={() => void addText()} disabled={busy || !sourceText.trim()}>Add text</button></div>
            </div>}

            {selectedId && <div className="rounded-xl border p-5"><div className="flex items-center justify-between"><h3 className="font-semibold">Sources</h3><button className="rounded-lg border px-3 py-2 text-sm" onClick={() => void refreshSources()}>Refresh</button></div><div className="mt-4 divide-y">{sources.map((s) => <div key={idOf(s)} className="flex items-center justify-between gap-3 py-3"><div className="min-w-0"><p className="truncate text-sm font-medium">{titleOf(s)}</p><p className="truncate text-xs text-muted-foreground">{s.url || idOf(s)}</p></div><button className="rounded-lg p-2 text-destructive" onClick={() => void deleteSource(idOf(s))} disabled={busy}><Trash2 className="h-4 w-4" /></button></div>)}{!sources.length && <p className="py-4 text-sm text-muted-foreground">No sources returned.</p>}</div></div>}
          </section>
        </div>
      </div>
    </main>
  );
}
