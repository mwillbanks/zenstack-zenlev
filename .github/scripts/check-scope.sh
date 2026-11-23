#!/usr/bin/env bash
set -euo pipefail

base=$1
head=$2

package=false
website=false
templates=false
markdown=false

all_checks() {
  package=true
  website=true
  templates=true
  markdown=true
}

report() {
  printf 'package=%s\nwebsite=%s\ntemplates=%s\nmarkdown=%s\n' \
    "$package" "$website" "$templates" "$markdown"
}

# Dispatches and pushes without a known base need full validation.
if [[ -z "$base" || "$base" =~ ^0+$ ]] || ! git cat-file -e "$base^{commit}" 2>/dev/null; then
  all_checks
  report
  exit 0
fi

# Disable rename detection so both the old and new path select their checks.
git diff --no-renames --name-only -z "$base" "$head" -- | {
  while IFS= read -r -d '' file; do
    case "$file" in
      .github/ISSUE_TEMPLATE/*|.github/scripts/lint-issue-templates.ts)
        templates=true ;;
      .github/workflows/docs.yml|website/*)
        website=true ;;
      .github/workflows/ci.yml|.github/scripts/check-scope.sh)
        all_checks ;;
      .github/workflows/release.yml)
        package=true
        website=true ;;
      .github/workflows/*|.github/dependabot.yml|.gitignore|LICENSE|logo.svg|release-please-config.json|.release-please-manifest.json)
        ;;
      src/*|test/*|scripts/*)
        package=true ;;
      *.md)
        markdown=true ;;
      *)
        package=true ;;
    esac
  done
  report
}
