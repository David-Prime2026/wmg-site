# WMG OS — System Context

## Product
WMG OS is an internal commodity management operating system for Wilson Marketing Group.
Internal users: Skip, Kevin, Alisa, Dena, and future admins.
External users: nonprofit sellers and buyers via read-limited portals.

## What it manages
Full lifecycle of nonprofit seller loads sold to buyers:
load intake → buyer assignment → Load Board tracking → sales memos → 
pricing → payment notices → AR validation → seller statements → 
weekly load lists → email/OCR processing → customer portal visibility.

## Database: Supabase Postgres
- All migrations are numbered sequentially: 001, 002, 003...
- All migrations are idempotent (use IF NOT EXISTS, IF EXISTS guards)
- RLS enabled on every table from creation — no exceptions
- Schemas: app (core data), private (internal logic), auth (Supabase native)
- Never use public schema as a dumping ground

## Known entities
users, roles, CRM accounts, parent/child account relationships, contacts,
portal access settings, seller accounts, buyer accounts, commodities,
commodity monthly pricing, loads, load states, release numbers, sales memos,
load orders, reroutes, invoices, BOLs, payments, payment notices, 
payment matching records, AR records, seller statements, statement lines,
adjustments, weekly load lists, email records, OCR documents, notifications,
audit log entries, SOP/tutorial records, workflow settings, master data lists
