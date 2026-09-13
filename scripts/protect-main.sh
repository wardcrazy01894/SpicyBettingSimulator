#!/usr/bin/env bash
# Lock down `main` (same setup as Alex's other repos):
#   - all changes via PR (0 required approvals, so a solo dev can self-merge)
#   - required status checks must pass and the branch must be up to date
#   - rules also apply to admins
#   - no force-pushes, no branch deletion
#   - conversation resolution required
#   - branches auto-delete on merge
#
# Contexts must match the job `name:` fields in .github/workflows/ci.yml.
# Branch protection needs a PUBLIC repo on the GitHub Free plan.
#
# Run:  bash scripts/protect-main.sh
set -euo pipefail

REPO="${1:-wardcrazy01894/SpicyBettingSimulator}"

echo "Applying branch protection to $REPO@main ..."
gh api -X PUT "repos/$REPO/branches/main/protection" --input - <<'JSON'
{
  "required_status_checks": {
    "strict": true,
    "contexts": ["typecheck / lint / format / test / build", "gitleaks"]
  },
  "enforce_admins": true,
  "required_pull_request_reviews": {
    "dismiss_stale_reviews": false,
    "require_code_owner_reviews": false,
    "required_approving_review_count": 0
  },
  "restrictions": null,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_linear_history": false,
  "required_conversation_resolution": true
}
JSON

echo "Enabling delete-branch-on-merge + squash merges ..."
gh api -X PATCH "repos/$REPO" -f delete_branch_on_merge=true -f allow_squash_merge=true >/dev/null

echo "Done. main is PR-only; required checks: 'typecheck / lint / format / test / build', 'gitleaks'."
