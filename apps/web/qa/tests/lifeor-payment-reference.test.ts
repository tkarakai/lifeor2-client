import { expect, test } from "bun:test";
import { paymentAccountReferenced } from "../../src/lib/lifeor/payment-reference";
test("expense payment references require original user evidence, not an incidental amount", () => {
  const name = "Household bills checking · 1042";
  expect(paymentAccountReferenced(name, "account-id", ["Record an expense for $1042."])).toBe(false);
  expect(paymentAccountReferenced(name, "account-id", ["Record another grocery expense for $50."])).toBe(false);
  expect(paymentAccountReferenced(name, "account-id", ["Paid from Household bills checking."])).toBe(true);
  expect(paymentAccountReferenced(name, "account-id", ["Use checking account ending 1042."])).toBe(true);
  expect(paymentAccountReferenced(name, "account-id", ["Use account-id."])).toBe(true);
  expect(paymentAccountReferenced("Ellis checking", "id", ["Record $72.45 from Ellis checking.", "Another $50 for groceries."])).toBe(true);
});
