import { describe, expect, it } from "vitest";
import {
  assessCommunication,
  communicationScenarios,
} from "../src/cli/communication-scenarios";

const [ordinary] = communicationScenarios;
const technical = communicationScenarios.find(
  (scenario) => scenario.technicalDetails
);
if (!(ordinary && technical)) {
  throw new Error("The communication scenarios are incomplete.");
}

describe("communication evaluation", () => {
  it("flags internal mechanics in an ordinary answer while allowing requested diagnostics", () => {
    const response = "open_preview failed with ECONNREFUSED on localhost:5173.";
    expect(assessCommunication(ordinary, response).issues).toContain(
      "unsolicited_internal_details"
    );
    expect(assessCommunication(technical, response).issues).toEqual([]);
  });

  it("keeps actionable product blockers visible without requiring raw diagnostics", () => {
    expect(
      assessCommunication(
        ordinary,
        "The preview is unavailable. You can request another attempt."
      ).issues
    ).toEqual([]);
  });

  it("flags a missing response, excessive verbosity, and private identifiers even in diagnostic answers", () => {
    expect(assessCommunication(ordinary, "  ").issues).toContain(
      "missing_response"
    );
    expect(
      assessCommunication(ordinary, "word ".repeat(ordinary.maxWords + 1))
        .issues
    ).toContain("excessive_length");
    expect(
      assessCommunication(technical, "Run private-run-id failed.", [
        "private-run-id",
      ]).issues
    ).toContain("internal_identity_disclosure");
  });
});
