import * as core from "@actions/core";

async function run() {
  const name = core.getInput("name") || "world";
  core.info(`Hello ${name} from ln80 action 👋`);
}

run().catch(err => {
  core.setFailed(err instanceof Error ? err.message : String(err));
});
