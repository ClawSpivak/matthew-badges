#!/bin/bash
# Called by the badge scanner after every new badge is saved.
# Commits the updated collection + photos and pushes to GitHub.

cd /Users/clawspivak/badge-hunter

BADGE_NAME="${1:-new badge}"

git add state/badge-collection.json app/photos/
git diff --cached --quiet && exit 0   # nothing changed

git commit -m "Add: $BADGE_NAME"
git push origin main
