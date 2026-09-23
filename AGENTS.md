# Open-source maintenance workspace

- Maintain this repository independently. The sibling development edition is not a source of private configuration, data, unpublished code or dependencies.
- When explicitly requested, reference the sibling edition's approved public-facing icons and window labels. Limit synchronization to those assets and presentation behavior; exclude concept artwork and unrelated code.
- Read the reliability contract in `maintenance/reliability.md` and the latest local delivery report before continuing verification.
- Explain the method and define observable requirements before implementation. Reproduce defects before changing their behavior, then verify the result.
- Use English code and comments; prefer Chinese user-facing text. Locate specifications by concepts rather than line numbers.
- Protect existing changes and use disposable profiles for runtime, backup, restore and installation tests. Never stop processes by executable name.
- Review and simplify the completed diff before committing the task's changes. Keep commits free of development-progress labels and tool attribution.
- Keep local evidence, credentials, runtime data and release artifacts out of source commits. The owner authorizes routine publication of reviewed and verified open-source changes to `origin/opensource`; follow `maintenance/repository-workflow.md`. Do not force-push, publish the sibling edition or upload release artifacts without the corresponding release instruction.
- Store native build outputs under this workspace on E:. Do not run broad cleanup against retained release artifacts.
