import { afterEach, expect, test } from "vitest";
import { isLocalDevelopment, assertMockEmailAllowed } from "./developmentOnly";
const original = process.env.SITE_URL;
afterEach(() => {
  process.env.SITE_URL = original;
});
test("development access requires every configured app origin to be loopback HTTP", () => {
  for (const site of [
    "https://client.example",
    "http://192.168.1.2:3001",
    "http://localhost:3001,https://client.example",
    "",
  ]) {
    process.env.SITE_URL = site;
    expect(isLocalDevelopment()).toBe(false);
    expect(() => assertMockEmailAllowed()).toThrow(
      "EMAIL_DELIVERY_NOT_CONFIGURED",
    );
  }
  process.env.SITE_URL = "http://localhost:3001,http://127.0.0.1:3002";
  expect(isLocalDevelopment()).toBe(true);
});
