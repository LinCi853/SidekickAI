# Public repository maintenance

The standalone workspace is an independently maintained early distribution of the local development edition. This product relationship does not require an additional GitHub branch. The public `LinCi853/SidekickAI` project is maintained directly on `main`, tracking `origin/main`.

The owner authorizes routine local commits and publication of reviewed, verified open-source changes to the public main project. Do not force-push or rewrite history. The sibling development workspace stays independent and its unpublished changes are not automatically distributed. Runtime profiles, credentials, local evidence and release archives stay outside source commits. Release executable uploads require their corresponding release instruction.

Use the existing main checkout for daily work:

```powershell
git status --short --branch
git fetch origin
git pull --ff-only
```

Inspect changes, run relevant checks and commit only the task's owned files. Then publish directly:

```powershell
git push origin main:main
```

Fetch does not merge files. A fast-forward pull stops on divergent history so both sides can be reviewed. Do not introduce a topic-branch or pull-request requirement merely because the local product has separate editions. Create another branch only when explicitly requested.

ProjectHub registers this workspace as `sidekickai-opensource`, alongside `sidekickai` in the same product family. The shared project set is a navigation and product relationship. Its Git manager supports selected-file local commits; project tasks expose status, history, fetch, fast-forward updates and direct main publication. The existing preview shows command, directory, effects and logs before execution.

Registration changes use the current registry digest and normal save services. Generated views come from the CLI. Keep the other projects' declarations and queue positions unchanged.

For verification, check the exact repository root, clean committed source, main tracking relationship and remote commit after push. Remove the previously created `opensource` reference only after its commits are contained in the published main history. Keep the local release archives and verification evidence.
