"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Plus, Trash2, Save, Loader2, Star } from "lucide-react";
import type { P0Customer } from "@/types/triage";
import { formatDate } from "@/lib/utils";

export default function P0Page() {
  const [list, setList] = useState<P0Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState({ name: "", jqlFragment: "", notes: "" });
  const [adding, setAdding] = useState(false);

  async function refresh() {
    setLoading(true);
    const data = await fetch("/api/p0").then((r) => r.json());
    setList(data);
    setLoading(false);
  }

  useEffect(() => {
    refresh();
  }, []);

  async function add() {
    if (!draft.name.trim() || !draft.jqlFragment.trim()) return;
    setAdding(true);
    try {
      await fetch("/api/p0", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(draft),
      });
      setDraft({ name: "", jqlFragment: "", notes: "" });
      await refresh();
    } finally {
      setAdding(false);
    }
  }

  return (
    <div className="flex-1 overflow-auto scroll-thin">
      <header className="px-6 h-14 border-b border-border flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Star className="h-4 w-4 text-warning" />
          <h1 className="text-lg font-semibold">P0 Customers</h1>
          <span className="text-xs text-fg-muted">{list.length} configured</span>
        </div>
      </header>

      <div className="p-6 space-y-6 max-w-4xl">
        <Card>
          <CardHeader>
            <CardTitle>Add a P0 customer</CardTitle>
            <span className="text-[11px] text-fg-subtle">
              Daily tracking + weekly summary will be generated for each
            </span>
          </CardHeader>
          <CardBody className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label>Customer name</Label>
                <Input
                  placeholder="Acme Corp"
                  value={draft.name}
                  onChange={(e) => setDraft({ ...draft, name: e.target.value })}
                />
              </div>
              <div className="space-y-1.5">
                <Label>JQL fragment (ANDed with master JQL)</Label>
                <Input
                  placeholder='labels = "customer-acme" OR "Account[Customer]" = "Acme"'
                  value={draft.jqlFragment}
                  onChange={(e) => setDraft({ ...draft, jqlFragment: e.target.value })}
                />
              </div>
            </div>
            <div className="space-y-1.5">
              <Label>Notes (optional)</Label>
              <Textarea
                placeholder="Renewal Q3. CSM: Lily. Known sensitive to slipped dates."
                value={draft.notes}
                onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
              />
            </div>
            <div className="flex justify-end">
              <Button onClick={add} disabled={adding || !draft.name || !draft.jqlFragment}>
                {adding ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Plus className="h-3.5 w-3.5" />}
                Add
              </Button>
            </div>
          </CardBody>
        </Card>

        {loading ? (
          <div className="flex items-center gap-2 text-fg-muted text-sm">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : list.length === 0 ? (
          <Card>
            <CardBody className="text-center text-fg-muted text-sm py-10">
              No P0 customers yet. Add your first above.
            </CardBody>
          </Card>
        ) : (
          <div className="space-y-3">
            {list.map((c) => (
              <P0Row key={c.id} customer={c} onChanged={refresh} />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function P0Row({ customer, onChanged }: { customer: P0Customer; onChanged: () => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(customer);
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      await fetch(`/api/p0/${customer.id}`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          name: draft.name,
          jqlFragment: draft.jqlFragment,
          notes: draft.notes,
        }),
      });
      setEditing(false);
      onChanged();
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!confirm(`Remove "${customer.name}" from P0 list?`)) return;
    await fetch(`/api/p0/${customer.id}`, { method: "DELETE" });
    onChanged();
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>{editing ? (
          <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
        ) : customer.name}</CardTitle>
        <div className="flex items-center gap-2">
          <span className="text-[11px] text-fg-subtle">
            Last analyzed: {formatDate(customer.lastAnalyzedAt)}
          </span>
          {editing ? (
            <>
              <Button size="sm" variant="secondary" onClick={() => { setDraft(customer); setEditing(false); }}>
                Cancel
              </Button>
              <Button size="sm" onClick={save} disabled={saving}>
                {saving ? <Loader2 className="h-3 w-3 animate-spin" /> : <Save className="h-3 w-3" />}
                Save
              </Button>
            </>
          ) : (
            <>
              <Button size="sm" variant="secondary" onClick={() => setEditing(true)}>
                Edit
              </Button>
              <Button size="sm" variant="danger" onClick={remove}>
                <Trash2 className="h-3 w-3" />
              </Button>
            </>
          )}
        </div>
      </CardHeader>
      <CardBody className="space-y-3 text-sm">
        <div className="space-y-1.5">
          <Label>JQL fragment</Label>
          {editing ? (
            <Textarea
              value={draft.jqlFragment}
              onChange={(e) => setDraft({ ...draft, jqlFragment: e.target.value })}
            />
          ) : (
            <code className="block rounded bg-bg-muted border border-border px-3 py-2 text-xs font-mono break-all">
              {customer.jqlFragment}
            </code>
          )}
        </div>
        {(editing || customer.notes) && (
          <div className="space-y-1.5">
            <Label>Notes</Label>
            {editing ? (
              <Textarea
                value={draft.notes ?? ""}
                onChange={(e) => setDraft({ ...draft, notes: e.target.value })}
              />
            ) : (
              <p className="text-fg-muted text-sm whitespace-pre-wrap">{customer.notes}</p>
            )}
          </div>
        )}
      </CardBody>
    </Card>
  );
}
