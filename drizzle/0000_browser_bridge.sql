CREATE TABLE browser_leases (
  owner TEXT PRIMARY KEY NOT NULL,
  session TEXT NOT NULL,
  seen INTEGER NOT NULL
);
--> statement-breakpoint
CREATE TABLE bridge_commands (
  id TEXT PRIMARY KEY NOT NULL,
  owner TEXT NOT NULL,
  session TEXT NOT NULL,
  name TEXT NOT NULL,
  status TEXT NOT NULL,
  created INTEGER NOT NULL,
  expires INTEGER NOT NULL,
  request_key TEXT NOT NULL,
  response_key TEXT NOT NULL
);
--> statement-breakpoint
CREATE INDEX bridge_owner_status ON bridge_commands(owner,session,status,created);
--> statement-breakpoint
CREATE INDEX bridge_owner_expiry ON bridge_commands(owner,expires);
