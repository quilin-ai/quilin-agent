import type { BudgetLedger } from "./state.js";

export const DEFAULT_RETRY_TOKEN_CAP_PCT = 0.15;

export interface BudgetLedgerInput {
	readonly tokenBudget: number;
	readonly turnBudget: number;
	readonly stepBudget: number;
	readonly retryTokenBudget?: number;
	readonly retryTokenBudgetPct?: number;
	readonly tokenSpent?: number;
	readonly turnSpent?: number;
	readonly retryTokenSpent?: number;
	readonly stepSpent?: number;
}

export interface BudgetCharge {
	readonly tokens?: number;
	readonly turns?: number;
	readonly retryTokens?: number;
	readonly steps?: number;
}

export interface BudgetRemaining {
	readonly tokens: number;
	readonly turns: number;
	readonly retryTokens: number;
	readonly steps: number;
}

export type BudgetExceededDimension = "step" | "turn" | "retry" | "token";

export type BudgetTerminalReason =
	| "MaxSteps"
	| "TurnBudgetExceeded"
	| "RetryBudgetExceeded"
	| "ResourceExhausted";

export type BudgetDecision =
	| {
			readonly kind: "continue";
			readonly budget: BudgetLedger;
			readonly remaining: BudgetRemaining;
	  }
	| {
			readonly kind: "terminal";
			readonly budget: BudgetLedger;
			readonly remaining: BudgetRemaining;
			readonly exceeded: BudgetExceededDimension;
			readonly reason: BudgetTerminalReason;
	  };

const TERMINAL_REASON_BY_DIMENSION: Record<
	BudgetExceededDimension,
	BudgetTerminalReason
> = {
	step: "MaxSteps",
	turn: "TurnBudgetExceeded",
	retry: "RetryBudgetExceeded",
	token: "ResourceExhausted",
};

const TERMINAL_DIMENSION_ORDER: readonly BudgetExceededDimension[] = [
	"step",
	"turn",
	"retry",
	"token",
];

function assertNonNegativeInteger(
	value: number | undefined,
	field: string,
): number {
	if (value == null) {
		return 0;
	}

	if (!Number.isInteger(value) || value < 0) {
		throw new RangeError(`${field} must be a non-negative integer`);
	}

	return value;
}

function resolveRetryTokenBudget(input: BudgetLedgerInput): number {
	if (input.retryTokenBudget != null) {
		return assertNonNegativeInteger(input.retryTokenBudget, "retryTokenBudget");
	}

	const retryPct = input.retryTokenBudgetPct ?? DEFAULT_RETRY_TOKEN_CAP_PCT;
	if (!Number.isFinite(retryPct) || retryPct < 0) {
		throw new RangeError("retryTokenBudgetPct must be a non-negative number");
	}

	return Math.floor(input.tokenBudget * retryPct);
}

export function createBudgetLedger(input: BudgetLedgerInput): BudgetLedger {
	const tokenBudget = assertNonNegativeInteger(
		input.tokenBudget,
		"tokenBudget",
	);
	const turnBudget = assertNonNegativeInteger(input.turnBudget, "turnBudget");
	const stepBudget = assertNonNegativeInteger(input.stepBudget, "stepBudget");
	const retryTokenBudget = resolveRetryTokenBudget({
		...input,
		tokenBudget,
	});

	return {
		tokenBudget,
		tokenSpent: assertNonNegativeInteger(input.tokenSpent, "tokenSpent"),
		turnBudget,
		turnSpent: assertNonNegativeInteger(input.turnSpent, "turnSpent"),
		retryTokenBudget,
		retryTokenSpent: assertNonNegativeInteger(
			input.retryTokenSpent,
			"retryTokenSpent",
		),
		stepBudget,
		stepSpent: assertNonNegativeInteger(input.stepSpent, "stepSpent"),
	};
}

export function getBudgetRemaining(budget: BudgetLedger): BudgetRemaining {
	return {
		tokens: budget.tokenBudget - budget.tokenSpent,
		turns: budget.turnBudget - budget.turnSpent,
		retryTokens: budget.retryTokenBudget - budget.retryTokenSpent,
		steps: budget.stepBudget - budget.stepSpent,
	};
}

function firstExceededDimension(
	remaining: BudgetRemaining,
): BudgetExceededDimension | null {
	for (const dimension of TERMINAL_DIMENSION_ORDER) {
		switch (dimension) {
			case "step":
				if (remaining.steps < 0) {
					return dimension;
				}
				break;
			case "turn":
				if (remaining.turns < 0) {
					return dimension;
				}
				break;
			case "retry":
				if (remaining.retryTokens < 0) {
					return dimension;
				}
				break;
			case "token":
				if (remaining.tokens < 0) {
					return dimension;
				}
				break;
		}
	}

	return null;
}

export function evaluateBudget(budget: BudgetLedger): BudgetDecision {
	const remaining = getBudgetRemaining(budget);
	const exceeded = firstExceededDimension(remaining);

	if (exceeded == null) {
		return {
			kind: "continue",
			budget,
			remaining,
		};
	}

	return {
		kind: "terminal",
		budget,
		remaining,
		exceeded,
		reason: TERMINAL_REASON_BY_DIMENSION[exceeded],
	};
}

export function consumeBudget(
	budget: BudgetLedger,
	charge: BudgetCharge,
): BudgetDecision {
	const nextBudget: BudgetLedger = {
		...budget,
		tokenSpent:
			budget.tokenSpent + assertNonNegativeInteger(charge.tokens, "tokens"),
		turnSpent:
			budget.turnSpent + assertNonNegativeInteger(charge.turns, "turns"),
		retryTokenSpent:
			budget.retryTokenSpent +
			assertNonNegativeInteger(charge.retryTokens, "retryTokens"),
		stepSpent:
			budget.stepSpent + assertNonNegativeInteger(charge.steps, "steps"),
	};

	return evaluateBudget(nextBudget);
}
