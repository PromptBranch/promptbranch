const userAgent = process.env.npm_config_user_agent ?? "";

if (userAgent.startsWith("pnpm/")) {
  process.exit(0);
}

console.error(
  "Refusing to publish a PromptBranch workspace package with npm. Run `pnpm publish` from the package directory so workspace:* dependencies are rewritten to registry versions.",
);
process.exitCode = 1;
