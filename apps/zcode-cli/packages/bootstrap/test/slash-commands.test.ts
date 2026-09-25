import assert from "node:assert/strict";
import { test } from "node:test";
import { listProtocolSlashCommands } from "../src/zcode-protocol/slash-commands.js";

test("App protocol slash catalog exposes fixed /skill usage to the composer", async () => {
  const commands = await listProtocolSlashCommands({ skipUserConfig: true });
  const skill = commands.find((command) => command.name === "skill");

  assert.deepEqual(skill, {
    description: "List skills, or force the next prompt to load one.",
    inputHint: "/skill [<skill-name> [task]]",
    name: "skill",
    source: "builtin",
  });
});
