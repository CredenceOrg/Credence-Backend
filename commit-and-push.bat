@echo off
echo Staging changes...
git add -A

echo Committing changes...
git commit -m "fix: lazy-load config to avoid test initialization issues"

echo Pushing changes...
git push

echo Done!
