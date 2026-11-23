#!/usr/bin/env bash
set -euo pipefail

base=$1
head=$2

package=false
website=false
templates=false
markdown=false
skills=false

all_checks() {
  package=true
  website=true
  templates=true
  markdown=true
  skills=true
}

report() {
  printf 'package=%s\nwebsite=%s\ntemplates=%s\nmarkdown=%s\nskills=%s\n' \
    "$package" "$website" "$templates" "$markdown" "$skills"
}

# Dispatches and pushes without a known base need full validation.
if [[ -z "$base" || "$base" =~ ^0+$ ]] || ! git cat-file -e "$base^{commit}" 2>/dev/null; then
  all_checks
  report
  exit 0
fi

skill_sources=$(jq -r 'to_entries[].value.files | keys[]' skills-review.json)

# Disable rename detection so both the old and new path select their checks.
git diff --no-renames --name-only -z "$base" "$head" -- | {
  while IFS= read -r -d '' file; do
    if [[ $'\n'$skill_sources$'\n' == *$'\n'"$file"$'\n'* ]]; then
      skills=true
    fi
    case "$file" in
      website/content/docs/guides/_skills/*/scripts/*)
        skills=true
        package=true ;;
      website/content/docs/guides/_skills/*|skills-review.json)
        skills=true ;;
      scripts/skills.ts|test/skills.test.ts|package.json|bun.lock|.gitignore)
        skills=true
        package=true ;;
      .github/ISSUE_TEMPLATE/*|.github/scripts/lint-issue-templates.ts)
        templates=true ;;
      .github/workflows/docs.yml|website/*)
        website=true ;;
      .github/workflows/ci.yml|.github/scripts/check-scope.sh)
        all_checks ;;
      .github/workflows/release.yml)
        package=true
        website=true
        skills=true ;;
      .github/workflows/*|.github/dependabot.yml|LICENSE|logo.svg|release-please-config.json|.release-please-manifest.json)
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
