import { expect, test } from "bun:test";
import { paymentAccountReferenced, expenseCategoryReferenced } from "../../src/lib/lifeor/payment-reference";
test("expense payment references require original user evidence, not an incidental amount", () => {
  const name = "Household bills checking · 1042";
  expect(paymentAccountReferenced(name, "account-id", ["Record an expense for $1042."])).toBe(false);
  expect(paymentAccountReferenced(name, "account-id", ["Record another grocery expense for $50."])).toBe(false);
  expect(paymentAccountReferenced(name, "account-id", ["Paid from Household bills checking."])).toBe(true);
  expect(paymentAccountReferenced(name, "account-id", ["Use checking account ending 1042."])).toBe(true);
  expect(paymentAccountReferenced(name, "account-id", ["Use account-id."])).toBe(true);
  expect(paymentAccountReferenced("Ellis checking", "id", ["Record $72.45 from Ellis checking.", "Another $50 for groceries."])).toBe(true);
});


test("an unspecified expense cannot acquire a category from a household name", () => {
  expect(expenseCategoryReferenced("Ellis groceries", "food-id", ["Record $500 from Ellis checking."])).toBe(false);
  expect(expenseCategoryReferenced("Ellis groceries", "food-id", ["Record a grocery expense from Ellis checking."])).toBe(true);
  expect(expenseCategoryReferenced("Groceries and household supplies", "food-id", ["$12.34 for groceries"])).toBe(true);
  expect(expenseCategoryReferenced("Custom category", "custom-id", ["Record $500 in Custom category."])).toBe(true);
  expect(expenseCategoryReferenced("Groceries", "food-id", ["Record $500."])).toBe(false);
});
