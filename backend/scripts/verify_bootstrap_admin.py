"""Read-only post-login verification. Does not invent or modify a Google subject.

Run from backend/: python scripts/verify_bootstrap_admin.py
"""

from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from config import SUPER_ADMIN_EMAIL, supabase  # noqa: E402


def main() -> int:
    rows = supabase.table('users').select('id,email,google_subject,active').ilike('email', SUPER_ADMIN_EMAIL).execute().data
    if len(rows) != 1:
        print('FAIL: expected exactly one permanent Super Admin user record')
        return 1
    user = rows[0]
    # Avoid logging the durable Google identifier; report whether the check passes.
    print({'id': user['id'], 'email': user['email'], 'google_subject_persisted': bool(user['google_subject']), 'active': user['active']})
    return 0 if user['google_subject'] and user['active'] is True else 1


if __name__ == '__main__':
    raise SystemExit(main())
