import { describe, expect, it } from "vitest";
import {
	consumeBudget,
	createBudgetLedger,
	DEFAULT_RETRY_TOKEN_CAP_PCT,
	evaluateBudget,
	getBudgetRemaining,
} from "./budget.js";

describe("createBudgetLedger", () => {
	it("derives the retry token cap from the default percentage", () => {
		const ledger = createBudgetLedger({
			tokenBudget: 1_000,
			turnBudget: 4,
			stepBudget: 6,
		});

		expect(ledger).toEqual({
			tokenSpent: 0,
			tokenBudget: 1_000,
			turnSpent: 0,
			turnBudget: 4,
			retryTokenSpent: 0,
			retryTokenBudget: Math.floor(1_000 * DEFAULT_RETRY_TOKEN_CAP_PCT),
			stepSpent: 0,
			stepBudget: 6,
		});
	});

	it("rejects negative or non-integer inputs", () => {
		expect(() =>
			createBudgetLedger({
				tokenBudget: -1,
				turnBudget: 4,
				stepBudget: 6,
			}),
		).toThrow(/tokenBudget/);

		expect(() =>
			consumeBudget(
				createBudgetLedger({
					tokenBudget: 100,
					turnBudget: 4,
					stepBudget: 6,
				}),
				{ tokens: 1.5 },
			),
		).toThrow(/tokens/);
	});
});

describe("consumeBudget", () => {
	it("charges token, turn, retry, and step counters deterministically", () => {
		const ledger = createBudgetLedger({
			tokenBudget: 500,
			turnBudget: 5,
			stepBudget: 8,
			retryTokenBudget: 60,
		});

		const decision = consumeBudget(ledger, {
			tokens: 120,
			turns: 1,
			retryTokens: 20,
			steps: 2,
		});

		expect(decision.kind).toBe("continue");
		expect(decision.budget).toEqual({
			tokenSpent: 120,
			tokenBudget: 500,
			turnSpent: 1,
			turnBudget: 5,
			retryTokenSpent: 20,
			retryTokenBudget: 60,
			stepSpent: 2,
			stepBudget: 8,
		});
		expect(decision.remaining).toEqual({
			tokens: 380,
			turns: 4,
			retryTokens: 40,
			steps: 6,
		});
	});

	it("allows exact boundary matches without forcing termination", () => {
		const ledger = createBudgetLedger({
			tokenBudget: 120,
			turnBudget: 2,
			stepBudget: 3,
			retryTokenBudget: 30,
			tokenSpent: 100,
			turnSpent: 1,
			stepSpent: 2,
			retryTokenSpent: 10,
		});

		const decision = consumeBudget(ledger, {
			tokens: 20,
			turns: 1,
			steps: 1,
			retryTokens: 20,
		});

		expect(decision.kind).toBe("continue");
		expect(decision.remaining).toEqual({
			tokens: 0,
			turns: 0,
			retryTokens: 0,
			steps: 0,
		});
	});

	it.each([
		{
			name: "step",
			ledger: createBudgetLedger({
				tokenBudget: 500,
				turnBudget: 5,
				stepBudget: 1,
				retryTokenBudget: 50,
				stepSpent: 1,
			}),
			charge: { steps: 1 },
			expected: { exceeded: "step", reason: "MaxSteps" },
		},
		{
			name: "turn",
			ledger: createBudgetLedger({
				tokenBudget: 500,
				turnBudget: 1,
				stepBudget: 5,
				retryTokenBudget: 50,
				turnSpent: 1,
			}),
			charge: { turns: 1 },
			expected: { exceeded: "turn", reason: "TurnBudgetExceeded" },
		},
		{
			name: "retry",
			ledger: createBudgetLedger({
				tokenBudget: 500,
				turnBudget: 5,
				stepBudget: 5,
				retryTokenBudget: 10,
				retryTokenSpent: 10,
			}),
			charge: { retryTokens: 1 },
			expected: { exceeded: "retry", reason: "RetryBudgetExceeded" },
		},
		{
			name: "token",
			ledger: createBudgetLedger({
				tokenBudget: 100,
				turnBudget: 5,
				stepBudget: 5,
				retryTokenBudget: 50,
				tokenSpent: 100,
			}),
			charge: { tokens: 1 },
			expected: { exceeded: "token", reason: "ResourceExhausted" },
		},
	])("returns a terminal decision when the %s budget is exceeded", ({ ledger, charge, expected }) => {
		const decision = consumeBudget(ledger, charge);

		expect(decision).toMatchObject({
			kind: "terminal",
			exceeded: expected.exceeded,
			reason: expected.reason,
		});
	});
});

describe("evaluateBudget", () => {
	it("uses a stable exceeded-dimension order when multiple limits are already broken", () => {
		const decision = evaluateBudget(
			createBudgetLedger({
				tokenBudget: 100,
				turnBudget: 1,
				stepBudget: 1,
				retryTokenBudget: 10,
				tokenSpent: 101,
				turnSpent: 2,
				stepSpent: 2,
				retryTokenSpent: 11,
			}),
		);

		expect(decision).toMatchObject({
			kind: "terminal",
			exceeded: "step",
			reason: "MaxSteps",
		});
		expect(getBudgetRemaining(decision.budget)).toEqual({
			tokens: -1,
			turns: -1,
			retryTokens: -1,
			steps: -1,
		});
	});
});
