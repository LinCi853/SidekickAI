# Open-source repository workflow

## Repository ownership

This checkout independently maintains the public `LinCi853/SidekickAI` repository. The `opensource` branch is the maintained standalone line and tracks `origin/opensource`. The remote URL is `https://github.com/LinCi853/SidekickAI.git`.

The owner authorizes routine local commits and publication of reviewed, verified open-source changes to this branch. This supersedes the earlier push-disabled configuration. Do not publish the sibling development edition, runtime profiles, credentials, local evidence or release archives through source commits. The public `main` branch remains the historical baseline until an explicit integration decision; do not force-push, rewrite history or change the default branch.

Existing topic branches retain their history. For a new change, branch from `opensource`, verify the change, commit only owned files and integrate it back into `opensource`. Local branch switching must preserve uncommitted work. Fetching updates does not merge them. Pulls use fast-forward only; divergence requires reviewing both histories before integration.

## Daily commands

```powershell
git switch opensource
git status --short --branch
git fetch origin
git log --oneline --graph --decorate --all -20
git pull --ff-only
```

Inspect changes and run the relevant checks, then select files and make a local commit. Publish the maintained branch with:

```powershell
git push origin opensource:opensource
```

The explicit refspec publishes only the local `opensource` branch. Commits on another branch must be reviewed and integrated first. Push authorization covers source updates; uploading release executables and merging into the public default branch remain separate release decisions.

## ProjectHub integration

The standalone edition is registered as `sidekickai-opensource`, in the `sidekickai` product family, beside the independent development edition. A project set provides a common navigation entry, with the standalone edition selected by default.

ProjectHub's Git manager handles selected-file local commits. Registered project tasks provide branch status, history, switching to the maintained branch, fetching, fast-forward updating and explicit branch publication. Existing task previews display the command, directory, effects and logs before execution. The integration uses existing registration and workflow services; it does not broaden Git actions for other projects.

The registration declaration remains ProjectHub's authority and is saved with registry digest validation and a recovery record. Generated views are refreshed by the CLI. Existing project declarations and queue positions are preserved; a pinned P0 inbox entry keeps this edition accessible when the active and next queues are full.

## Acceptance

Verify the exact independent Git root, clean committed source, fetch/push URLs, local branch and tracking branch. Verify remote write access without publishing, then push the reviewed maintenance branch and read back its commit. Validate the ProjectHub declaration, project-set membership, read-only Git status and registered task previews. Keep local evidence outside Git and retain earlier branches and package archives.
