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
// `GET /workflows` returns 100 rows by default, so a full list may be truncated.
const WORKFLOW_LIST_LIMIT = 100;
const MIN_MONTHLY_USD = 0.01;

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

/** Off stores 0, and float4 storage turns a tiny workflow limit into 0 and a huge one into Infinity. */
function isMonthlyInvalid(value: string): boolean {
  if (value.trim() === "") return false;
  const n = Number(value);
  return !Number.isFinite(Math.fround(n)) || n < MIN_MONTHLY_USD;
}

function isWarnInvalid(value: string): boolean {
  if (value.trim() === "") return false;
  const n = Number(value);
  // The server reads a threshold of 0 as its default of 80.
  return !Number.isInteger(n) || n < 1 || n > 100;
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

/** Shortest decimal that stores as the same float4: 7.099999904632568 is 7.1, 123456.78125 is 123456.78. */
function float4Text(value: number): string {
  for (let digits = 1; digits < 9; digits++) {
    const candidate = Number(value.toPrecision(digits));
    if (Math.fround(candidate) === Math.fround(value)) return String(candidate);
  }
  return String(value);
}

/**
 * A workflow without its own limit reports the org's envelope, and a stored 0 hides the
 * row's old warning and policy, so a new limit starts from what governs the workflow now.
 */
function workflowDraft(envelope: BudgetEnvelope): BudgetDraft {
  const limit = envelope.resolvedScope === "workflow" ? envelope.monthlyUsdLimit : null;
  return {
    limitOn: typeof limit === "number",
    monthlyUsd: typeof limit === "number" ? float4Text(limit) : "",
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
        // The last good read stays so a failed refresh can't close an open row editor.
        if (!cancelled) setState((current) => ({ envelope: current.envelope, failed: true }));
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

function BudgetNumberField({ error, id, label, max, min, onChange, step, value }: {
  error?: string;
  id: string;
  label: string;
  max?: number;
  min: number;
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
          min={min}
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
            min={MIN_MONTHLY_USD}
            step={0.01}
            value={draft.monthlyUsd}
            onChange={(monthlyUsd) => onChange({ monthlyUsd })}
          />
          <BudgetNumberField
            id={`${prefix}-warn`}
            label={t("budget.field.warn")}
            error={isWarnInvalid(draft.warnPercent) ? t("budget.errorWarn") : undefined}
            max={100}
            min={1}
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
  const editorRowRef = useRef<HTMLTableRowElement>(null);
  const draft = edits ?? saved ?? OFF_DRAFT;

  const closeEditor = () => {
    setEdits(null);
    setSaveError(null);
    // A save can finish after another row's editor opened: leave focus there.
    if (editorRowRef.current) editButtonRef.current?.focus();
    onEditingChange(false);
  };

  const save = async () => {
    setSaving(true);
    setSaveError(null);
    try {
      await api(`/workflows/${encodeURIComponent(workflow.id)}/budget`, {
        method: "POST",
        body: JSON.stringify(draft.limitOn
          ? { monthlyUsd: Number(draft.monthlyUsd), warnPercent: Number(draft.warnPercent), policy: draft.policy }
          : { monthlyUsd: 0 }),
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

  const rowHasLimit = !failed && saved?.limitOn === true;
  return (
    <>
      <tr data-testid={`budget-workflow-row-${workflow.id}`}>
        <td>{workflow.name ?? workflow.id}</td>
        <td data-testid={`budget-workflow-limit-${workflow.id}`}>
          {failed ? t("budget.errorLoad")
            : !saved ? "…"
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
            disabled={!editing && (!saved || failed)}
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
        <tr ref={editorRowRef} className="we-budget-table__editor">
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
  // The open editor's row stays through filtering and paging so its draft survives.
  const matches = workflows.filter((workflow) => workflow.id === editingId
    || (workflow.name ?? workflow.id).toLowerCase().includes(query));
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
      {matches.length === 0 ? (
        <p className="helper-text" data-testid="budget-workflow-no-match">
          {workflows.length >= WORKFLOW_LIST_LIMIT
            ? t("budget.workflow.noMatchPartial", { count: workflows.length })
            : t("budget.workflow.noMatch")}
        </p>
      ) : (
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
              {matches.filter((workflow, index) => index < visible || workflow.id === editingId).map((workflow) => (
                <WorkflowBudgetRow
                  key={workflow.id}
                  editing={editingId === workflow.id}
                  onEditingChange={(editing) => setEditingId((current) => (editing ? workflow.id : current === workflow.id ? null : current))}
                  reloadKey={reloadKey}
                  workflow={workflow}
                />
              ))}
            </tbody>
          </table>
        </div>
      )}
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
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const error = saveError ?? loadError;
  const draft = edits ?? saved ?? OFF_DRAFT;

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
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
        setLoadError(err instanceof Error ? err.message : (t("budget.errorLoad")));
      });
    return () => { cancelled = true; };
  }, [platformVersion, t]);

  const saveOrgBudget = async () => {
    setSaving(true);
    setSaveError(null);
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
      setSaveError(tApiError(err) || (t("budget.errorSave")));
      // Some of the writes may have landed: the form stays locked until the server says what it holds.
      setSaved(null);
      bumpPlatformVersion(BUDGET_MUTATION_TAGS);
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
        {saved?.limitOn && !spendFailed && hasMeasuredSpend(envelope) && <BudgetMeter envelope={envelope} testId="budget-org-meter" />}
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
