"""Deploy Huddle to Hugging Face Spaces using upload_folder API."""
import os
import sys

TOKEN = sys.argv[1] if len(sys.argv) > 1 else os.getenv("HF_TOKEN", "")
REPO = sys.argv[2] if len(sys.argv) > 2 else "FunWith/quick-meet"

if not TOKEN:
    print("Usage: python deploy_hf.py <HF_TOKEN> [repo_id]")
    sys.exit(1)


from huggingface_hub import HfApi

print(f"Deploying to {REPO}...")
api = HfApi(token=TOKEN)

try:
    info = api.whoami()
    print(f"Authenticated as: {info['name']}")
except Exception as e:
    print(f"Auth failed: {e}")
    sys.exit(1)

folder = os.path.dirname(os.path.abspath(__file__))
print(f"Uploading from: {folder}")

# Create space if it doesn't exist
try:
    api.repo_info(repo_id=REPO, repo_type="space")
    print(f"Space {REPO} already exists.")
except Exception:
    print(f"Creating space {REPO}...")
    api.create_repo(repo_id=REPO, repo_type="space", space_sdk="docker", private=False)
    print("Space created.")

api.upload_folder(
    folder_path=folder,
    repo_id=REPO,
    repo_type="space",
    ignore_patterns=[
        "__pycache__", "__pycache__/**", "*.pyc", ".env", "deploy_hf.py",
        "desktop", "desktop/**",
        "node_modules", "node_modules/**",
        "package-lock.json", "package.json",
        "*.exe", "dist", "dist/**",
        "_check_user.py", "_check_dict_space.py", "_compare_remote.py",
        "_list_remote.py", "_restart_space.py", "_status.py",
        "_*.py",
        "DOCUMENTATION.md",
        "AI_Assistant_UseCase_Model.md", "pics", "pics/**",
        "landing", "landing/**",
    ],
)
print("Deploy complete!")
print(f"View at: https://huggingface.co/spaces/{REPO}")
