"use client";

import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardBody, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label, Textarea } from "@/components/ui/input";
import { Plus, Trash2, Save, Loader2 } from "lucide-react";
import type { P0Customer } from "@/types/triage";
import { formatDate } from "@/lib/utils";

/**
 * Configurable white-glove (P0) customer list — add/edit/remove. Persists
 * immediately via /api/p0 (independent of the Settings "Save" button). Rendered
 * as a section within Settings.
 */
export function WhiteGloveCustomers() {
  const [list, setList] = useState<P0Customer[]>([]);
  const [loading, setLoading] = useState(true);
  const [draft, setDraft] = useState({ name: "", jqlFragment: "", notes: "" });
  const [adding, setAdding] = useState(false);

  async function refresh() {
    setLoading(true);
    const data = await fetch("/api/p0").then((r) => r.json());
    setList(Array.isArray(data) ? data : []);
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
    <Card>
      <CardHeader>
        <CardTitle>White-glove customers</CardTitle>
        <span className="text-[11px] text-fg-subtle">
          {list.length} configured · watched across Customer Defects, Feature Requests & Tenant Health
        </span>
      </CardHeader>
      <CardBody className="space-y-4">
        {/* Add form */}
        <div className="space-y-3 rounded border border-border bg-bg-muted/20 p-3">
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
              <Label>JQL fragment (AND&apos;d with each dashboard&apos;s JQL)</Label>
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
        </div>

        {/* List */}
        {loading ? (
          <div className="flex items-center gap-2 text-fg-muted text-sm">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading…
          </div>
        ) : list.length === 0 ? (
          <p className="text-sm text-fg-muted">No white-glove customers yet. Add your first above.</p>
        ) : (
          <div className="space-y-3">
            {list.map((c) => (
              <P0Row key={c.id} customer={c} onChanged={refresh} />
            ))}
          </div>
        )}
      </CardBody>
    </Card>
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
        body: JSON.stringify({ name: draft.name, jqlFragment: draft.jqlFragment, notes: draft.notes }),
      });
      setEditing(false);
      onChanged();
    } finally {
      setSaving(false);
    }
  }

  async function remove() {
    if (!confirm(`Remove "${customer.name}" from white-glove customer list?`)) return;
    await fetch(`/api/p0/${customer.id}`, { method: "DELETE" });
    onChanged();
  }

  return (
    <div className="rounded border border-border bg-bg-card p-3 space-y-2">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0 flex-1">
          {editing ? (
            <Input value={draft.name} onChange={(e) => setDraft({ ...draft, name: e.target.value })} />
          ) : (
            <span className="font-semibold text-fg">{customer.name}</span>
          )}
        </div>
        <div className="flex items-center gap-2 shrink-0">
          <span className="text-[11px] text-fg-subtle">Last analyzed: {formatDate(customer.lastAnalyzedAt)}</span>
          {editing ? (
            <>
              <Button
                size="sm"
                variant="secondary"
                onClick={() => {
                  setDraft(customer);
                  setEditing(false);
                }}
              >
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
      </div>
      <div className="space-y-1.5">
        <Label>JQL fragment</Label>
        {editing ? (
          <Textarea value={draft.jqlFragment} onChange={(e) => setDraft({ ...draft, jqlFragment: e.target.value })} />
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
            <Textarea value={draft.notes ?? ""} onChange={(e) => setDraft({ ...draft, notes: e.target.value })} />
          ) : (
            <p className="text-fg-muted text-sm whitespace-pre-wrap">{customer.notes}</p>
          )}
        </div>
      )}
    </div>
  );
}
