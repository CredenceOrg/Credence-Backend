import subprocess
import sys

def run_command(cmd):
    """Run a command and return the result"""
    print(f"Running: {cmd}")
    result = subprocess.run(cmd, shell=True, capture_output=True, text=True)
    print(result.stdout)
    if result.stderr:
        print(result.stderr, file=sys.stderr)
    return result.returncode

# Stage all changes
print("=== Staging changes ===")
run_command("git add -A")

# Commit changes
print("\n=== Committing changes ===")
run_command('git commit -m "fix: lazy-load config to avoid test initialization issues"')

# Push changes
print("\n=== Pushing changes ===")
run_command("git push")

print("\n=== Done! ===")
