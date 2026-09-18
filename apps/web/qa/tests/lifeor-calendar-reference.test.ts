import { expect, test } from "bun:test";
import { calendarReferences, preservingClockTime } from "../../src/lib/lifeor/calendar-reference";
test("relative calendar anchors come from the current user wording without resolving dates in the model", () => {
  expect(calendarReferences("Record a dentist appointment next Tuesday at 3 PM, America/Chicago.")).toEqual(["next tuesday"]);
  expect(calendarReferences("Move it two days later, at the same time.")).toEqual(["two days later"]);
  expect(preservingClockTime("Move it two days later, at the same time.")).toBe(true);
  expect(calendarReferences("Actually make that 10:30 in the morning tomorrow.")).toEqual(["tomorrow"]);
  expect(calendarReferences("Record a visit the day after tomorrow at 3 PM.")).toEqual(["the day after tomorrow"]);
  expect(calendarReferences("Create a visit tomorrow and a meeting in two weeks.")).toEqual(["tomorrow", "in two weeks"]);
  expect(calendarReferences('Record an event titled "Tomorrow Never Dies".')).toEqual([]);
  expect(calendarReferences("Move from next Tuesday to September 29.")).toEqual([]);
  expect(calendarReferences("Not tomorrow; September 29 instead.")).toEqual([]);
  expect(preservingClockTime("Do not use the same time. Use 4 PM.")).toBe(false);
});
