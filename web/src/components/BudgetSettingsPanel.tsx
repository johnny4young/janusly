/**
 * AI budget editor in Settings: the org-wide meter and limit, then per-workflow
 * overrides as table rows. Spend comes from `GET /billing/budget`, which only
 * measures it while a limit applies. Off stores a monthly limit of 0.
 */

import { useEffect, useRef, useState } from "react";
import { AlertTriangle, Coins, Info, Save, ShieldAlert } from "lucide-react";
import { api } from "../api";
import { readSavedWorkflowPage } from "../lib/list-contract";
import type { SavedWorkflow } from "../types";
import { useWorkflowStore } from "../store";
import { tApiError, useT } from "../i18n";
import { Button } from "./ui/Button";
import { FormActions, FormField, FormSection, TextInput } from "./ui/Form";
import { StatusSummary } from "./ui/StatusSummary";
import { parseOrgConfigEntries } from "../lib/org-config-model";
import { PLATFORM_TAG, useInvalidationNonce } from '../lib/query-cache'
import { budgetBand, type BudgetEnvelope } from "./recovery-center/recovery-center-model";
import "./BudgetSettingsPanel.css";

const BUDGET_MUTATION_TAGS = ['billing', 'org-config'] as const

const BUDGET_TAGS = [PLATFORM_TAG, 'billing', 'org-config', 'workflows'] as const

// There is no list endpoint for overrides: each visible row issues its own read.
const WORKFLOW_PAGE_SIZE = 10;

type BudgetPolicy = "warn" | "block";

type BudgetDraft = {
  limitOn: boolean;
  monthlyUsd: string;
  warnPercent: string;
  policy: BudgetPolicy;
};

type WorkflowSummaryRow = Pick<SavedWorkflow, "id" | "name">;

const OFF_DRAFT: BudgetDraft = { limitOn: false, monthlyUsd: "", warnPercent: "80", policy: "warn" };

const ORG_CONFIG_KEYS = {
  monthlyUsd: "ai.budgetMonthlyUsd",
  warnPercent: "ai.budgetWarnPercent",
  policy: "ai.budgetExceededPolicy",
} as const;

/** Content that isn't a positive number; 0 is what Off stores, so a limit can't be 0. */
function isMonthlyInvalid(value: string): boolean {
  if (value.trim() === "") return false;
  const n = Number(value);
  return !Number.isFinite(n) || n <= 0;
}

function isWarnInvalid(value: string): boolean {
  if (value.trim() === "") return false;
  const n = Number(value);
  return !Number.isInteger(n) || n < 0 || n > 100;
}

function isDraftReady(draft: BudgetDraft): boolean {
  if (!draft.limitOn) return true;
  return draft.monthlyUsd.trim() !== "" && draft.warnPercent.trim() !== ""
    && !isMonthlyInvalid(draft.monthlyUsd) && !isWarnInvalid(draft.warnPercent);
}

function isSameDraft(a: BudgetDraft, b: BudgetDraft): boolean {
  if (!a.limitOn && !b.limitOn) return true;
  return a.limitOn === b.limitOn && a.monthlyUsd === b.monthlyUsd
    && a.warnPercent === b.warnPercent && a.policy === b.policy;
}

/** A workflow without its own limit reports the org's spend and limit, not its own. */
function workflowDraft(envelope: BudgetEnvelope): BudgetDraft {
  if (envelope.resolvedScope !== "workflow" || typeof envelope.monthlyUsdLimit !== "number") return OFF_DRAFT;
  return {
    limitOn: true,
    // Stored as float4: 7.1 reads back as 7.099999904632568.
    monthlyUsd: String(Number(envelope.monthlyUsdLimit.toPrecision(7))),
    warnPercent: String(envelope.warningPercent ?? 80),
    policy: envelope.policy === "block" ? "block" : "warn",
  };
}

function hasMeasuredSpend(envelope: BudgetEnvelope | null): envelope is BudgetEnvelope {
  return typeof envelope?.monthlyUsdSpent === "number"
    && typeof envelope.monthlyUsdLimit === "number" && envelope.monthlyUsdLimit > 0;
}

function useBudgetEnvelope(path: string, reloadKey: number) {
  const [state, setState] = useState<{ envelope: BudgetEnvelope | null; failed: boolean }>({ envelope: null, failed: false });
  useEffect(() => {
    let cancelled = false;
    api(path)
      .then((payload) => {
        if (!cancelled) setState({ envelope: payload as BudgetEnvelope, failed: false });
      })
      .catch(() => {
        if (!cancelled) setState({ envelope: null, failed: true });
      });
    return () => { cancelled = true; };
  }, [path, reloadKey]);
  return state;
}

function BudgetMeter({ envelope, compact = false, testId }: { envelope: BudgetEnvelope; compact?: boolean; testId: string }) {
  const { t } = useT();
  const spent = envelope.monthlyUsdSpent ?? 0;
  const limit = envelope.monthlyUsdLimit ?? 0;
  const warnPercent = envelope.warningPercent ?? 80;
  const value = t("budget.meter.value", { spent: spent.toFixed(2), limit: limit.toFixed(2) });
  const status = envelope.allowed === false ? t("budget.status.blocking")
    : envelope.exceededAt ? t("budget.status.over")
      : envelope.warningThresholdCrossed ? t("budget.status.warn") : null;
  return (
    <div className={compact ? "we-budget-meter we-budget-meter--compact" : "we-budget-meter"} data-band={budgetBand(envelope)} data-testid={testId}>
      <div className="we-budget-meter__row">
        <strong>{compact ? `$${spent.toFixed(2)}` : value}</strong>
        <span>{Math.round((spent / limit) * 100)}%</span>
        {status && <span className="we-budget-meter__status">{status}</span>}
        {!compact && <span className="we-budget-meter__warn">{t("budget.meter.warnAt", { percent: warnPercent })}</span>}
      </div>
      <div
        className="we-budget-meter__bar"
        role="meter"
        aria-label={t("budget.meter.label")}
        aria-valuemin={0}
        aria-valuemax={limit}
        aria-valuenow={Math.min(spent, limit)}
        aria-valuetext={value}
      >
        <span className="we-budget-meter__fill" style={{ width: `${Math.min(100, (spent / limit) * 100)}%` }} />
        <span className="we-budget-meter__tick" style={{ left: `${warnPercent}%` }} />
      </div>
    </div>
  );
}

function BudgetNumberField({ error, id, label, max, onChange, step, value }: {
  error?: string;
  id: string;
  label: string;
  max?: number;
  onChange: (value: string) => void;
  step: number;
  value: string;
}) {
  return (
    <FormField id={id} label={label} error={error}>
      {(controlProps) => (
        <input
          {...controlProps}
          type="number"
          min={0}
          max={max}
          step={step}
          value={value}
          onChange={(event) => onChange(event.target.value)}
          data-testid={id}
        />
      )}
    </FormField>
  );
}

function BudgetLimitFields({ draft, offLabel, onChange, prefix }: {
  draft: BudgetDraft;
  offLabel: string;
  onChange: (patch: Partial<BudgetDraft>) => void;
  prefix: string;
}) {
  const { t } = useT();
  return (
    <>
      <div className="we-budget-mode" role="radiogroup" aria-label={t("budget.mode.label")}>
        {[false, true].map((on) => (
          <label key={String(on)}>
            <input
              type="radio"
              className="we-sr-only"
              name={`${prefix}-mode`}
              checked={draft.limitOn === on}
              onChange={() => onChange({ limitOn: on })}
              data-testid={`${prefix}-mode-${on ? "limit" : "off"}`}
            />
            <span>{on ? t("budget.mode.limit") : offLabel}</span>
          </label>
        ))}
      </div>
      {draft.limitOn && (
        <div className="we-budget-fields">
          <BudgetNumberField
            id={`${prefix}-monthly`}
            label={t("budget.field.monthly")}
            error={isMonthlyInvalid(draft.monthlyUsd) ? t("budget.errorMonthly") : undefined}
            step={0.01}
            value={draft.monthlyUsd}
            onChange={(monthlyUsd) => onChange({ monthlyUsd })}
          />
          <BudgetNumberField
            id={`${prefix}-warn`}
            label={t("budget.field.warn")}
            error={isWarnInvalid(draft.warnPercent) ? t("budget.errorWarn") : undefined}
            max={100}
            step={1}
            value={draft.warnPercent}
            onChange={(warnPercent) => onChange({ warnPercent })}
          />
          <FormField id={`${prefix}-policy`} label={t("budget.field.policy")}>
            {(controlProps) => (
              <select
                {...controlProps}
                value={draft.policy}
                onChange={(event) => onChange({ policy: event.target.value === "block" ? "block" : "warn" })}
                data-testid={`${prefix}-policy`}
              >
                <option value="warn">{t("budget.policy.warnLabel")}</option>
                <option value="block">{t("budget.policy.blockLabel")}</option>
              </select>
            )}
          </FormField>
        </div>
      )}
    </>
  );
}

function WorkflowBudgetRow({ editing, onEditingChange, reloadKey, workflow }: {
  editing: boolean;
  onEditingChange: (editing: boolean) => void;
  reloadKey: number;
  workflow: WorkflowSummaryRow;
}) {
  const { t } = useT();
  const bumpPlatformVersion = useWorkflowStore((state) => state.bumpPlatformVersion);
  const addToast = useWorkflowStore((state) => state.addToast);
  const { envelope, failed } = useBudgetEnvelope(`/billing/budget?workflowId=${encodeURIComponent(workflow.id)}`, reloadKey);
  const saved = envelope && workflowDraft(envelope);
  const [edits, setEdits] = useState<BudgetDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const editButtonRef = useRef<HTMLButtonElement>(null);
  const draft = edits ?? saved ?? OFF_DRAFT;

  const closeEditor = () => {
    setEdits(null);
    setSaveError(null);
    onEditingChange(false);
    editButtonRef.current?.focus();
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    // Off stores 0 and keeps the warning and policy already saved for this row.
    const source = draft.limitOn ? draft : saved ?? OFF_DRAFT;
    try {
      await api(`/workflows/${encodeURIComponent(workflow.id)}/budget`, {
        method: "POST",
        body: JSON.stringify({
          monthlyUsd: draft.limitOn ? Number(draft.monthlyUsd) : 0,
          warnPercent: Number(source.warnPercent),
          policy: source.policy,
        }),
      });
      closeEditor();
      addToast(t("budget.workflow.toastSaved"), "success");
      bumpPlatformVersion(BUDGET_MUTATION_TAGS);
    } catch (err) {
      setSaveError(tApiError(err) || t("budget.errorSave"));
    } finally {
      setSaving(false);
    }
  };

  const rowHasLimit = saved?.limitOn === true;
  return (
    <>
      <tr data-testid={`budget-workflow-row-${workflow.id}`}>
        <td>{workflow.name ?? workflow.id}</td>
        <td data-testid={`budget-workflow-limit-${workflow.id}`}>
          {saved === null
            ? (failed ? t("budget.errorLoad") : "…")
            : rowHasLimit ? t("budget.workflow.current", { usd: Number(saved.monthlyUsd).toFixed(2) }) : t("budget.org")}
        </td>
        <td>{rowHasLimit ? `${saved.warnPercent}%` : "—"}</td>
        <td>{rowHasLimit ? t(saved.policy === "block" ? "budget.policy.blockShort" : "budget.policy.warnShort") : "—"}</td>
        <td data-testid={`budget-workflow-spent-${workflow.id}`}>
          {rowHasLimit && hasMeasuredSpend(envelope)
            ? <BudgetMeter compact envelope={envelope} testId={`budget-workflow-meter-${workflow.id}`} />
            : "—"}
        </td>
        <td>
          <Button
            ref={editButtonRef}
            size="sm"
            disabled={saved === null}
            aria-expanded={editing}
            aria-label={t("budget.workflow.editAria", { name: workflow.name ?? workflow.id })}
            onClick={() => (editing ? closeEditor() : onEditingChange(true))}
            data-testid={`budget-workflow-edit-${workflow.id}`}
          >
            {t("common.edit")}
          </Button>
        </td>
      </tr>
      {editing && saved && (
        <tr className="we-budget-table__editor">
          <td colSpan={6}>
            <fieldset className="we-budget-editor" disabled={saving}>
              <BudgetLimitFields
                draft={draft}
                offLabel={t("budget.org")}
                onChange={(patch) => setEdits({ ...draft, ...patch })}
                prefix="budget-workflow"
              />
              {saveError && <StatusSummary role="alert" tone="danger" icon={<ShieldAlert size={16} />} title={saveError} />}
              <FormActions>
                <Button onClick={closeEditor} data-testid="budget-workflow-cancel">{t("common.cancel")}</Button>
                <Button
                  variant="primary"
                  onClick={save}
                  disabled={saving || !isDraftReady(draft) || isSameDraft(draft, saved)}
                  loading={saving}
                  loadingLabel={t("budget.saving")}
                  leadingIcon={<Save size={15} />}
                  data-testid="budget-workflow-save"
                >
                  {t("budget.workflow.action")}
                </Button>
              </FormActions>
            </fieldset>
          </td>
        </tr>
      )}
    </>
  );
}

function WorkflowBudgetTable({ reloadKey }: { reloadKey: number }) {
  const { t } = useT();
  const [workflows, setWorkflows] = useState<WorkflowSummaryRow[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [filter, setFilter] = useState("");
  const [visible, setVisible] = useState(WORKFLOW_PAGE_SIZE);
  const [editingId, setEditingId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    readSavedWorkflowPage()
      .then((payload) => {
        if (cancelled) return;
        setWorkflows(payload);
        setFailed(false);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => { cancelled = true; };
  }, [reloadKey]);

  if (workflows === null) return failed ? <p className="helper-text">{t("budget.errorLoad")}</p> : null;
  if (workflows.length === 0) return <p className="helper-text">{t("budget.workflow.empty")}</p>;

  const query = filter.trim().toLowerCase();
  const matches = query
    ? workflows.filter((workflow) => (workflow.name ?? workflow.id).toLowerCase().includes(query))
    : workflows;
  return (
    <>
      {workflows.length > WORKFLOW_PAGE_SIZE && (
        <TextInput
          type="search"
          aria-label={t("budget.workflow.filter")}
          placeholder={t("budget.workflow.filter")}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
          data-testid="budget-workflow-filter"
        />
      )}
      <div className="we-budget-table-wrap">
        <table className="we-budget-table" data-testid="budget-workflow-table">
          <thead>
            <tr>
              <th scope="col">{t("budget.workflow.label")}</th>
              <th scope="col">{t("budget.table.budget")}</th>
              <th scope="col">{t("budget.table.warn")}</th>
              <th scope="col">{t("budget.table.policy")}</th>
              <th scope="col">{t("budget.table.spent")}</th>
              <th scope="col"><span className="we-sr-only">{t("common.edit")}</span></th>
            </tr>
          </thead>
          <tbody>
            {matches.slice(0, visible).map((workflow) => (
              <WorkflowBudgetRow
                key={workflow.id}
                editing={editingId === workflow.id}
                onEditingChange={(editing) => setEditingId(editing ? workflow.id : null)}
                reloadKey={reloadKey}
                workflow={workflow}
              />
            ))}
          </tbody>
        </table>
      </div>
      {matches.length > visible && (
        <FormActions>
          <Button size="sm" onClick={() => setVisible((count) => count + WORKFLOW_PAGE_SIZE)} data-testid="budget-workflow-more">
            {t("budget.workflow.more")}
          </Button>
        </FormActions>
      )}
    </>
  );
}

export function BudgetSettingsPanel() {
  const { t } = useT();
  const bumpPlatformVersion = useWorkflowStore((state) => state.bumpPlatformVersion);
  const addToast = useWorkflowStore((state) => state.addToast);
  const platformVersion = useInvalidationNonce(BUDGET_TAGS)

  const [saved, setSaved] = useState<BudgetDraft | null>(null);
  // Unsaved edits sit apart from the saved values so a refresh can't discard them.
  const [edits, setEdits] = useState<BudgetDraft | null>(null);
  const { envelope, failed: spendFailed } = useBudgetEnvelope("/billing/budget", platformVersion);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const draft = edits ?? saved ?? OFF_DRAFT;

  useEffect(() => {
    let cancelled = false;
    setError(null);
    api("/org/config")
      .then((payload) => {
        if (cancelled) return;
        const byKey = new Map(parseOrgConfigEntries(payload).map((entry) => [entry.key, entry.value]));
        const monthly = Number(byKey.get(ORG_CONFIG_KEYS.monthlyUsd) ?? 0);
        setSaved({
          limitOn: monthly > 0,
          monthlyUsd: monthly > 0 ? String(monthly) : "",
          warnPercent: String(byKey.get(ORG_CONFIG_KEYS.warnPercent) ?? 80),
          policy: byKey.get(ORG_CONFIG_KEYS.policy) === "block" ? "block" : "warn",
        });
      })
      .catch((err) => {
        if (cancelled) return;
        setError(err instanceof Error ? err.message : (t("budget.errorLoad")));
      });
    return () => { cancelled = true; };
  }, [platformVersion, t]);

  const saveOrgBudget = async () => {
    setSaving(true);
    setError(null);
    try {
      await api("/org/config", {
        method: "POST",
        body: JSON.stringify({ key: ORG_CONFIG_KEYS.monthlyUsd, value: draft.limitOn ? Number(draft.monthlyUsd) : 0 }),
      });
      // Off keeps the saved warning and policy for when the limit returns.
      if (draft.limitOn) {
        await api("/org/config", {
          method: "POST",
          body: JSON.stringify({ key: ORG_CONFIG_KEYS.warnPercent, value: Number(draft.warnPercent) }),
        });
        await api("/org/config", {
          method: "POST",
          body: JSON.stringify({ key: ORG_CONFIG_KEYS.policy, value: draft.policy }),
        });
      }
      setSaved(draft);
      setEdits(null);
      addToast(t("budget.toastOrgSaved"), "success");
      bumpPlatformVersion(BUDGET_MUTATION_TAGS);
    } catch (err) {
      // Surface the failure inline only — the persistent form error below is
      // the single feedback channel here (no duplicate transient toast).
      setError(tApiError(err) || (t("budget.errorSave")));
    } finally {
      setSaving(false);
    }
  };

  const aboutSectionLabel = t("common.aboutSection");
  const budgetIntro = t("budget.intro");

  return (
    <section className="we-card we-budget-settings" aria-labelledby="budget-settings-heading" data-testid="budget-settings-panel">
      <div className="we-budget-settings__head">
        <span className="we-budget-settings__icon" aria-hidden="true"><Coins size={18} /></span>
        <div>
          <div className="section-kicker">{t("budget.kicker")}</div>
          <div className="we-heading-with-info">
            <h2 id="budget-settings-heading">{t("budget.heading")}</h2>
            <span
              className="we-info-icon"
              role="img"
              aria-label={`${aboutSectionLabel}: ${budgetIntro}`}
              title={budgetIntro}
            >
              <Info size={14} aria-hidden="true" />
            </span>
          </div>
        </div>
      </div>

      {error && (
        <StatusSummary
          role="alert"
          tone="danger"
          icon={<AlertTriangle size={16} />}
          title={error}
        />
      )}

      <FormSection title={t("budget.org")} disabled={saved === null || saving}>
        {saved?.limitOn && hasMeasuredSpend(envelope) && <BudgetMeter envelope={envelope} testId="budget-org-meter" />}
        {saved?.limitOn && spendFailed && (
          <p className="helper-text" data-testid="budget-org-spend-unavailable">{t("budget.meter.unavailable")}</p>
        )}
        {saved && !saved.limitOn && !draft.limitOn && (
          <p className="helper-text" data-testid="budget-org-off">{t("budget.off")}</p>
        )}
        <BudgetLimitFields
          draft={draft}
          offLabel={t("budget.mode.off")}
          onChange={(patch) => setEdits({ ...draft, ...patch })}
          prefix="budget-org"
        />
        <FormActions>
          <Button
            variant="primary"
            onClick={saveOrgBudget}
            disabled={saving || saved === null || !isDraftReady(draft) || isSameDraft(draft, saved)}
            loading={saving}
            loadingLabel={t("budget.saving")}
            leadingIcon={<Save size={15} />}
            data-testid="budget-org-save"
          >
            {t("budget.action.saveOrg")}
          </Button>
        </FormActions>
      </FormSection>

      <FormSection title={t("budget.workflow.title")}>
        <WorkflowBudgetTable reloadKey={platformVersion} />
      </FormSection>
    </section>
  );
}
