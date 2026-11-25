-- The Commerce module's first part: quotes and orders (docs/data-model.md §5.4, ADR 0014).
-- A quote is made for a deal (by default; a workspace can allow quotes without one), holds line
-- items, and is sent, then accepted. Accepting a quote makes an order with a copy of its lines.
-- Products, prices and price books are not built yet: a line names what is sold in its description,
-- and its product_id is a plain uuid that gets its foreign key when the catalogue arrives.

-- Document numbers (Q-0001, O-0001): one counter per workspace and document type, taken inside the
-- transaction that creates the document, so two at once never share a number.
CREATE TABLE number_sequences (
  tenant_id  uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  doc_type   text NOT NULL CHECK (doc_type IN ('quote', 'order')),
  next_value bigint NOT NULL DEFAULT 1 CHECK (next_value > 0),
  PRIMARY KEY (tenant_id, doc_type)
);
SELECT app.enable_tenant_rls('number_sequences');

CREATE TABLE quotes (
  tenant_id        uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  id               uuid NOT NULL,
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 500),
  number           text NOT NULL CHECK (length(number) BETWEEN 1 AND 40),
  -- The deal it prices. Required unless the workspace allows quotes without a deal (commerce settings).
  deal_id          uuid NULL,
  -- Customer of record: an account, a contact, or both.
  account_id       uuid NULL,
  contact_id       uuid NULL,
  -- Every version of one quote shares a group; a revision is the next version in it.
  quote_group_id   uuid NOT NULL,
  quote_version    int NOT NULL DEFAULT 1 CHECK (quote_version > 0),
  status           text NOT NULL DEFAULT 'draft',
  status_category  text NOT NULL DEFAULT 'draft' CHECK (status_category IN ('draft', 'sent', 'accepted', 'rejected', 'expired', 'superseded')),
  currency         char(3) NOT NULL,
  subtotal_minor   bigint NOT NULL DEFAULT 0,
  discount_minor   bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  tax_minor        bigint NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  total_minor      bigint NOT NULL DEFAULT 0,
  valid_until      date NULL,
  terms            text NULL CHECK (length(terms) <= 20000),
  sent_at          timestamptz NULL,
  accepted_at      timestamptz NULL,
  -- The customer's names as they were when the quote was sent: what the document said, whatever changes later.
  snapshot         jsonb NULL,
  owner_id         uuid NULL,
  search_text      text NOT NULL DEFAULT '',
  external_ids     jsonb NOT NULL DEFAULT '{}',
  custom           jsonb NOT NULL DEFAULT '{}',
  custom_encrypted jsonb NOT NULL DEFAULT '{}',
  version          int NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid NULL,
  archived_at      timestamptz NULL,
  PRIMARY KEY (tenant_id, id),
  CHECK (account_id IS NOT NULL OR contact_id IS NOT NULL),
  UNIQUE (tenant_id, number),
  UNIQUE (tenant_id, quote_group_id, quote_version),
  FOREIGN KEY (tenant_id, deal_id) REFERENCES deals (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_id) REFERENCES users (tenant_id, id)
);
CREATE INDEX quotes_deal ON quotes (tenant_id, deal_id);
CREATE INDEX quotes_account ON quotes (tenant_id, account_id);
CREATE INDEX quotes_contact ON quotes (tenant_id, contact_id);
CREATE INDEX quotes_search ON quotes USING gin (search_text gin_trgm_ops);
-- A deal has at most one accepted quote.
CREATE UNIQUE INDEX quotes_one_accepted_per_deal ON quotes (tenant_id, deal_id) WHERE status_category = 'accepted' AND deal_id IS NOT NULL;

CREATE TABLE quote_line_items (
  tenant_id         uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  id                uuid NOT NULL,
  quote_id          uuid NOT NULL,
  position          int NOT NULL DEFAULT 0,
  product_id        uuid NULL,
  description       text NOT NULL CHECK (length(description) BETWEEN 1 AND 2000),
  quantity          numeric(18, 4) NOT NULL DEFAULT 1 CHECK (quantity > 0),
  unit_amount_minor bigint NOT NULL CHECK (unit_amount_minor >= 0),
  discount_minor    bigint NOT NULL DEFAULT 0 CHECK (discount_minor >= 0),
  tax_minor         bigint NOT NULL DEFAULT 0 CHECK (tax_minor >= 0),
  line_total_minor  bigint NOT NULL,
  search_text       text NOT NULL DEFAULT '',
  external_ids      jsonb NOT NULL DEFAULT '{}',
  custom            jsonb NOT NULL DEFAULT '{}',
  custom_encrypted  jsonb NOT NULL DEFAULT '{}',
  version           int NOT NULL DEFAULT 1,
  created_at        timestamptz NOT NULL DEFAULT now(),
  created_by        uuid NULL,
  updated_at        timestamptz NOT NULL DEFAULT now(),
  updated_by        uuid NULL,
  archived_at       timestamptz NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, quote_id) REFERENCES quotes (tenant_id, id)
);
CREATE INDEX quote_line_items_quote ON quote_line_items (tenant_id, quote_id, position);

CREATE TABLE orders (
  tenant_id        uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  id               uuid NOT NULL,
  name             text NOT NULL CHECK (length(name) BETWEEN 1 AND 500),
  number           text NOT NULL CHECK (length(number) BETWEEN 1 AND 40),
  -- The quote it was made from (at most one order per quote), and that quote's deal.
  quote_id         uuid NULL,
  deal_id          uuid NULL,
  account_id       uuid NULL,
  contact_id       uuid NULL,
  order_type       text NOT NULL DEFAULT 'new' CHECK (order_type IN ('new', 'renewal', 'upsell', 'downgrade', 'cancellation')),
  effective_date   date NOT NULL DEFAULT CURRENT_DATE,
  status           text NOT NULL DEFAULT 'pending',
  status_category  text NOT NULL DEFAULT 'pending' CHECK (status_category IN ('pending', 'active', 'fulfilled', 'cancelled')),
  currency         char(3) NOT NULL,
  subtotal_minor   bigint NOT NULL DEFAULT 0,
  discount_minor   bigint NOT NULL DEFAULT 0,
  tax_minor        bigint NOT NULL DEFAULT 0,
  total_minor      bigint NOT NULL DEFAULT 0,
  terms            text NULL,
  snapshot         jsonb NULL,
  owner_id         uuid NULL,
  search_text      text NOT NULL DEFAULT '',
  external_ids     jsonb NOT NULL DEFAULT '{}',
  custom           jsonb NOT NULL DEFAULT '{}',
  custom_encrypted jsonb NOT NULL DEFAULT '{}',
  version          int NOT NULL DEFAULT 1,
  created_at       timestamptz NOT NULL DEFAULT now(),
  created_by       uuid NULL,
  updated_at       timestamptz NOT NULL DEFAULT now(),
  updated_by       uuid NULL,
  archived_at      timestamptz NULL,
  PRIMARY KEY (tenant_id, id),
  CHECK (account_id IS NOT NULL OR contact_id IS NOT NULL),
  UNIQUE (tenant_id, number),
  UNIQUE (tenant_id, quote_id),
  FOREIGN KEY (tenant_id, quote_id) REFERENCES quotes (tenant_id, id),
  FOREIGN KEY (tenant_id, deal_id) REFERENCES deals (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_id) REFERENCES users (tenant_id, id)
);
CREATE INDEX orders_deal ON orders (tenant_id, deal_id);
CREATE INDEX orders_account ON orders (tenant_id, account_id);
CREATE INDEX orders_contact ON orders (tenant_id, contact_id);
CREATE INDEX orders_search ON orders USING gin (search_text gin_trgm_ops);

CREATE TABLE order_line_items (
  tenant_id            uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  id                   uuid NOT NULL,
  order_id             uuid NOT NULL,
  position             int NOT NULL DEFAULT 0,
  product_id           uuid NULL,
  description          text NOT NULL,
  quantity             numeric(18, 4) NOT NULL,
  unit_amount_minor    bigint NOT NULL,
  discount_minor       bigint NOT NULL DEFAULT 0,
  tax_minor            bigint NOT NULL DEFAULT 0,
  line_total_minor     bigint NOT NULL,
  -- The quote line this one was copied from.
  quote_line_item_id   uuid NULL,
  search_text          text NOT NULL DEFAULT '',
  external_ids         jsonb NOT NULL DEFAULT '{}',
  custom               jsonb NOT NULL DEFAULT '{}',
  custom_encrypted     jsonb NOT NULL DEFAULT '{}',
  version              int NOT NULL DEFAULT 1,
  created_at           timestamptz NOT NULL DEFAULT now(),
  created_by           uuid NULL,
  updated_at           timestamptz NOT NULL DEFAULT now(),
  updated_by           uuid NULL,
  archived_at          timestamptz NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, order_id) REFERENCES orders (tenant_id, id),
  FOREIGN KEY (tenant_id, quote_line_item_id) REFERENCES quote_line_items (tenant_id, id)
);
CREATE INDEX order_line_items_order ON order_line_items (tenant_id, order_id, position);

-- RLS, registry and updated_at triggers, as for every object table (migration 003).
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('quotes', 'quote'), ('quote_line_items', 'quote_line_item'), ('orders', 'order'), ('order_line_items', 'order_line_item')
  ) AS t(tbl, obj) LOOP
    PERFORM app.enable_tenant_rls(r.tbl::regclass);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app.register_record(%L)',
                   r.tbl || '_registry', r.tbl, r.obj);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at()',
                   r.tbl || '_touch', r.tbl);
  END LOOP;
END $$;

-- What a quote said can't change once it has been sent: its number, what it prices, its amounts, its
-- terms and its snapshot. The service layer refuses first, with a clear error; this is the backstop.
-- Its status moves on, its owner and custom fields can change, and its customer of record can be
-- re-pointed (a merge of two accounts moves it; the snapshot keeps who it was issued to).
CREATE OR REPLACE FUNCTION app.quotes_sent_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status_category <> 'draft' AND (
       NEW.name IS DISTINCT FROM OLD.name OR NEW.number IS DISTINCT FROM OLD.number OR NEW.deal_id IS DISTINCT FROM OLD.deal_id
    OR NEW.quote_group_id IS DISTINCT FROM OLD.quote_group_id OR NEW.quote_version IS DISTINCT FROM OLD.quote_version
    OR NEW.currency IS DISTINCT FROM OLD.currency OR NEW.subtotal_minor IS DISTINCT FROM OLD.subtotal_minor
    OR NEW.discount_minor IS DISTINCT FROM OLD.discount_minor OR NEW.tax_minor IS DISTINCT FROM OLD.tax_minor
    OR NEW.total_minor IS DISTINCT FROM OLD.total_minor OR NEW.valid_until IS DISTINCT FROM OLD.valid_until
    OR NEW.terms IS DISTINCT FROM OLD.terms OR NEW.sent_at IS DISTINCT FROM OLD.sent_at OR NEW.snapshot IS DISTINCT FROM OLD.snapshot) THEN
    RAISE EXCEPTION 'a quote that has been sent cannot be changed; revise it instead' USING ERRCODE = 'check_violation', CONSTRAINT = 'quotes_sent_immutable';
  END IF;
  IF OLD.status_category = 'draft' AND NEW.status_category NOT IN ('draft', 'sent', 'superseded') THEN
    RAISE EXCEPTION 'a draft quote can only be sent or superseded' USING ERRCODE = 'check_violation', CONSTRAINT = 'quotes_status_order';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quotes_sent_immutable BEFORE UPDATE ON quotes FOR EACH ROW EXECUTE FUNCTION app.quotes_sent_immutable();

-- A quote's lines change only while it is a draft.
CREATE OR REPLACE FUNCTION app.quote_lines_draft_only() RETURNS trigger
LANGUAGE plpgsql AS $$
DECLARE q uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.quote_id ELSE NEW.quote_id END;
        t uuid := CASE WHEN TG_OP = 'DELETE' THEN OLD.tenant_id ELSE NEW.tenant_id END;
BEGIN
  IF EXISTS (SELECT 1 FROM quotes WHERE tenant_id = t AND id = q AND status_category <> 'draft') THEN
    RAISE EXCEPTION 'the lines of a quote that has been sent cannot be changed' USING ERRCODE = 'check_violation', CONSTRAINT = 'quote_lines_draft_only';
  END IF;
  IF TG_OP = 'DELETE' THEN RETURN OLD; END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER quote_lines_draft_only BEFORE INSERT OR UPDATE OR DELETE ON quote_line_items
  FOR EACH ROW EXECUTE FUNCTION app.quote_lines_draft_only();

-- An order is a record of what was agreed: only its status, owner, custom fields and customer
-- references change after it is made, and its lines never do.
CREATE OR REPLACE FUNCTION app.orders_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.name IS DISTINCT FROM OLD.name OR NEW.number IS DISTINCT FROM OLD.number OR NEW.quote_id IS DISTINCT FROM OLD.quote_id
     OR NEW.deal_id IS DISTINCT FROM OLD.deal_id OR NEW.order_type IS DISTINCT FROM OLD.order_type OR NEW.currency IS DISTINCT FROM OLD.currency
     OR NEW.subtotal_minor IS DISTINCT FROM OLD.subtotal_minor OR NEW.discount_minor IS DISTINCT FROM OLD.discount_minor
     OR NEW.tax_minor IS DISTINCT FROM OLD.tax_minor OR NEW.total_minor IS DISTINCT FROM OLD.total_minor
     OR NEW.terms IS DISTINCT FROM OLD.terms OR NEW.snapshot IS DISTINCT FROM OLD.snapshot THEN
    RAISE EXCEPTION 'an order cannot be changed, apart from its status' USING ERRCODE = 'check_violation', CONSTRAINT = 'orders_immutable';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER orders_immutable BEFORE UPDATE ON orders FOR EACH ROW EXECUTE FUNCTION app.orders_immutable();

CREATE OR REPLACE FUNCTION app.order_lines_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'the lines of an order cannot be changed' USING ERRCODE = 'check_violation', CONSTRAINT = 'order_lines_immutable';
END $$;
CREATE TRIGGER order_lines_immutable BEFORE UPDATE OR DELETE ON order_line_items FOR EACH ROW EXECUTE FUNCTION app.order_lines_immutable();

-- New workspaces start with the commerce module on; existing ones get it turned on here (a module
-- with no records changes nothing). Their quote and order objects are added to their metadata after
-- the migrations, from the catalog (db/migrate.ts), so the catalog stays the one definition.
ALTER TABLE tenants ALTER COLUMN modules SET DEFAULT ARRAY['core', 'sales', 'commerce'];
DO $$
DECLARE t uuid;
BEGIN
  FOR t IN SELECT tenant_id FROM tenant_directory LOOP
    PERFORM set_config('app.tenant_id', t::text, true);
    UPDATE tenants SET modules = modules || '{commerce}'::text[] WHERE tenant_id = t AND NOT modules @> '{commerce}' AND modules @> '{sales}';
  END LOOP;
  PERFORM set_config('app.tenant_id', '', true);
END $$;
