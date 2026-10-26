"""Run dataplatform's real data listener on a scratch store, for ArchiveBot's tests.

Usage: <dataplatform venv python> scratch_data_listener.py <root> <user_id>

Auth comes from WHOAMI_TEST_OVERRIDES (set by the caller), dataplatform's own
hermetic-test hook; everything else -- HTTP handling, store, CAS, limits -- is
the deployed code. Binds 127.0.0.1 on a free port and prints it.
"""
import sys
from pathlib import Path

from dataplatform.data.grants import Grants
from dataplatform.data.peers import StaticPeers
from dataplatform.data.server import make_server
from dataplatform.data import store as st

root, user_id = Path(sys.argv[1]), sys.argv[2]
grants = Grants(root / "namespaces.json")
grants.grant("archivebot", user_id)
server = make_server("127.0.0.1", 0, st.Store(root / "ns"), grants, StaticPeers(["127.0.0.1"]))
print(server.server_address[1], flush=True)
server.serve_forever()
