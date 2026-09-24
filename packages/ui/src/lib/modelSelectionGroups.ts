import {
  isZCodeAgentProvider,
  resolveModelProviderFamilySpecByProviderId,
  zcodeProviderAccountAccessSchema,
  type ZCodeProviderAccountAccess,
  type ZCodeProvider,
} from "@zcode/shared";
import type { ModelSelectionView } from "@zcode/services";
import type { ModelSelectGroup } from "@/ModelConfigSelect.js";
import { decodeCustomModelValue, encodeCustomModelValue } from "@/lib/zcodeCustomModelValue.js";
import { shouldShowModelVisionBadge } from "@/lib/modelVisionBadge.js";

export interface ModelProviderGroupLabelOptions {
  apiKeyLabel?: string;
  apiKeyBadgeLabel?: string;
  codingPlanLabel?: string;
  codingPlanBadgeLabel?: string;
  startPlanLabel?: string;
  startPlanBadgeLabel?: string;
  teamPlanBadgeLabel?: string;
  teamPlanFallbackLabel?: string;
}

export interface HarnessModelSelectOption {
  engineId: string;
  label: string;
  selectable: boolean;
  reason?: string;
}

/** Picker-only namespace; Harness identities are never encoded as provider/model identities. */
export const HARNESS_MODEL_SELECT_VALUE_PREFIX = "anyagent-harness:";

export function encodeHarnessModelSelectValue(engineId: string): string {
  return `${HARNESS_MODEL_SELECT_VALUE_PREFIX}${encodeURIComponent(engineId)}`;
}

export function decodeHarnessModelSelectValue(value: string): string | null {
  if (!value.startsWith(HARNESS_MODEL_SELECT_VALUE_PREFIX)) return null;
  try {
    const engineId = decodeURIComponent(value.slice(HARNESS_MODEL_SELECT_VALUE_PREFIX.length));
    return engineId.trim() ? engineId : null;
  } catch {
    return null;
  }
}

export function isHarnessModelSelectValue(value: string): boolean {
  return value.startsWith(HARNESS_MODEL_SELECT_VALUE_PREFIX);
}

export function buildHarnessModelSelectGroups(
  harnesses: readonly HarnessModelSelectOption[],
): ModelSelectGroup[] {
  const items = harnesses.flatMap((harness) => {
    const engineId = harness.engineId.trim();
    const label = harness.label.trim();
    if (!engineId || !label) return [];
    const reason = harness.reason?.trim();
    return [
      {
        key: `harness:${engineId}`,
        value: encodeHarnessModelSelectValue(engineId),
        name: label,
        ...(!harness.selectable && reason ? { badgeLabel: reason } : {}),
      },
    ];
  });
  return items.length > 0 ? [{ key: "harnesses", label: "Harness", directItems: true, items }] : [];
}

/** Dispatches picker intent without treating a Harness identifier as a Provider model. */
export function dispatchComposerModelSelectValue(params: {
  value: string;
  harnesses: readonly HarnessModelSelectOption[];
  sessionId: string | null;
  onSelectHarness: (engineId: string | null) => void;
  onSelectProvider: (value: string) => void;
}): "harness" | "provider" | "ignored" {
  if (isHarnessModelSelectValue(params.value)) {
    const engineId = decodeHarnessModelSelectValue(params.value);
    if (engineId === null) return "ignored";
    const harness = params.harnesses.find((candidate) => candidate.engineId === engineId);
    if (!harness?.selectable || params.sessionId !== null) return "ignored";
    params.onSelectHarness(engineId);
    return "harness";
  }

  params.onSelectHarness(null);
  params.onSelectProvider(params.value);
  return "provider";
}

function supportsRegistryApiFormat(
  selectedProvider: ZCodeProvider,
  apiFormat: string | null | undefined,
): boolean {
  if (!apiFormat) return false;
  // 仅剩 glm（ZCode Agent）provider；三方 CLI 的 api format 差异已随 provider 下线。
  return isZCodeAgentProvider(selectedProvider);
}

export function buildRegistryModelSelectGroups(
  selectedProvider: ZCodeProvider,
  view: ModelSelectionView,
  labels: ModelProviderGroupLabelOptions = {},
): ModelSelectGroup[] {
  return view.providers.flatMap((provider) => {
    if (!supportsRegistryApiFormat(selectedProvider, provider.config.api?.type)) {
      return [];
    }

    const accountAccess = zcodeProviderAccountAccessSchema.safeParse(provider.config.access);
    const accountPresentation = accountAccess.success
      ? getRegistryAccountProviderGroupPresentation(provider.providerId, accountAccess.data, labels)
      : null;

    return [
      {
        key: `registry-provider:${provider.providerId}`,
        label: accountPresentation?.label || provider.providerName?.trim() || provider.providerId,
        ...(accountPresentation?.labelBadge ? { labelBadge: accountPresentation.labelBadge } : {}),
        ...(accountPresentation ? { directItems: true } : {}),
        items: provider.models.map(({ modelId, config }) => ({
          key: `registry-provider:${provider.providerId}:${modelId}`,
          value: encodeCustomModelValue(provider.providerId, modelId),
          name: modelId,
          ...(shouldShowModelVisionBadge(
            modelId,
            config.properties?.inputFormat?.supportsImage,
            provider.config.access,
          )
            ? { supportsVisionInput: true }
            : {}),
        })),
      },
    ];
  });
}

function getRegistryAccountProviderGroupPresentation(
  providerId: string,
  access: ZCodeProviderAccountAccess,
  labels: ModelProviderGroupLabelOptions,
): Pick<ModelSelectGroup, "label" | "labelBadge"> {
  const familySpec = resolveModelProviderFamilySpecByProviderId(providerId);
  const label = familySpec?.label ?? providerId;
  if (access.mode === "start-plan") {
    return { label: "Start Plan", labelBadge: labels.startPlanBadgeLabel ?? "Free" };
  }
  if (access.mode === "team-coding-plan") {
    return { label, labelBadge: labels.teamPlanBadgeLabel ?? "Team" };
  }
  return { label, labelBadge: labels.codingPlanBadgeLabel ?? "Individual" };
}

export function resolveModelDisplayName(
  modelGroups: readonly ModelSelectGroup[],
  value: string,
): string | null {
  for (const group of modelGroups) {
    const matched = group.items.find((item) => item.value === value);
    if (matched) return matched.name;
  }

  return decodeCustomModelValue(value)?.modelName ?? null;
}
