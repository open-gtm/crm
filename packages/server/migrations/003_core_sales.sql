-- Core and Sales modules: typed tables for the standard objects.
-- Every object table carries the standard columns, custom fields in `custom`,
-- encrypted restricted custom fields in `custom_encrypted`, and a registry trigger.

CREATE TABLE accounts (
  tenant_id         uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  id                uuid NOT NULL,
  name              text NOT NULL CHECK (length(name) BETWEEN 1 AND 500),
  domains           text[] NOT NULL DEFAULT '{}',
  primary_domain    citext NULL,
  industry          text NULL,
  employee_count    int NULL CHECK (employee_count >= 0),
  billing_address   jsonb NULL,
  shipping_address  jsonb NULL,
  type              text NULL,
  parent_account_id uuid NULL,
  owner_id          uuid NULL,
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
  FOREIGN KEY (tenant_id, parent_account_id) REFERENCES accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_id) REFERENCES users (tenant_id, id),
  CHECK (parent_account_id IS DISTINCT FROM id)
);
CREATE UNIQUE INDEX accounts_domain ON accounts (tenant_id, primary_domain) WHERE archived_at IS NULL AND primary_domain IS NOT NULL;
CREATE INDEX accounts_domains ON accounts USING gin (domains);
CREATE INDEX accounts_search ON accounts USING gin (search_text gin_trgm_ops);
CREATE INDEX accounts_custom ON accounts USING gin (custom jsonb_path_ops);
CREATE INDEX accounts_owner ON accounts (tenant_id, owner_id);

-- Account hierarchies may not form cycles.
CREATE OR REPLACE FUNCTION app.accounts_no_cycle() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.parent_account_id IS NOT NULL AND EXISTS (
    WITH RECURSIVE up(id, depth) AS (
      SELECT a.parent_account_id, 1 FROM accounts a WHERE a.tenant_id = NEW.tenant_id AND a.id = NEW.parent_account_id
      UNION ALL
      SELECT a.parent_account_id, up.depth + 1 FROM accounts a JOIN up ON a.tenant_id = NEW.tenant_id AND a.id = up.id
      WHERE up.depth < 20
    )
    SELECT 1 FROM up WHERE id = NEW.id
  ) THEN
    RAISE EXCEPTION 'account hierarchy would form a cycle' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER accounts_no_cycle BEFORE INSERT OR UPDATE OF parent_account_id ON accounts
  FOR EACH ROW EXECUTE FUNCTION app.accounts_no_cycle();

CREATE TABLE contacts (
  tenant_id                  uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  id                         uuid NOT NULL,
  first_name                 text NULL,
  last_name                  text NULL,
  primary_email              citext NULL,
  primary_phone              text NULL,
  job_title                  text NULL,
  lifecycle_stage            text NOT NULL DEFAULT 'subscriber',
  lifecycle_category         text NOT NULL DEFAULT 'subscriber'
                               CHECK (lifecycle_category IN ('subscriber', 'lead', 'opportunity', 'customer', 'former_customer')),
  lifecycle_stage_overridden boolean NOT NULL DEFAULT false,
  source                     text NULL,
  primary_account_id         uuid NULL,
  owner_id                   uuid NULL,
  anonymized_at              timestamptz NULL,
  search_text                text NOT NULL DEFAULT '',
  external_ids               jsonb NOT NULL DEFAULT '{}',
  custom                     jsonb NOT NULL DEFAULT '{}',
  custom_encrypted           jsonb NOT NULL DEFAULT '{}',
  version                    int NOT NULL DEFAULT 1,
  created_at                 timestamptz NOT NULL DEFAULT now(),
  created_by                 uuid NULL,
  updated_at                 timestamptz NOT NULL DEFAULT now(),
  updated_by                 uuid NULL,
  archived_at                timestamptz NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, primary_account_id) REFERENCES accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_id) REFERENCES users (tenant_id, id),
  CHECK (first_name IS NOT NULL OR last_name IS NOT NULL OR primary_email IS NOT NULL)
);
CREATE UNIQUE INDEX contacts_email ON contacts (tenant_id, primary_email) WHERE archived_at IS NULL AND primary_email IS NOT NULL;
CREATE INDEX contacts_account ON contacts (tenant_id, primary_account_id);
CREATE INDEX contacts_owner ON contacts (tenant_id, owner_id);
CREATE INDEX contacts_search ON contacts USING gin (search_text gin_trgm_ops);
CREATE INDEX contacts_custom ON contacts USING gin (custom jsonb_path_ops);

CREATE TABLE account_contacts (
  tenant_id        uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  id               uuid NOT NULL,
  account_id       uuid NOT NULL,
  contact_id       uuid NOT NULL,
  role             text NULL,
  is_primary       boolean NOT NULL DEFAULT false,
  start_date       date NULL,
  end_date         date NULL,
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
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id),
  CHECK (end_date IS NULL OR start_date IS NULL OR end_date >= start_date)
);
CREATE UNIQUE INDEX account_contacts_current ON account_contacts (tenant_id, account_id, contact_id)
  WHERE archived_at IS NULL AND end_date IS NULL;
CREATE UNIQUE INDEX account_contacts_one_primary ON account_contacts (tenant_id, contact_id)
  WHERE is_primary AND archived_at IS NULL AND end_date IS NULL;
CREATE INDEX account_contacts_contact ON account_contacts (tenant_id, contact_id);

CREATE TABLE activity_types (
  tenant_id      uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  key            text NOT NULL CHECK (key ~ '^[a-z][a-z0-9_]{1,62}$'),
  label          text NOT NULL,
  payload_schema jsonb NOT NULL DEFAULT '{}',
  is_system      boolean NOT NULL DEFAULT false,
  editable       boolean NOT NULL DEFAULT false,  -- notes can be edited; other activities are history
  created_at     timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (tenant_id, key)
);
SELECT app.enable_tenant_rls('activity_types');

CREATE TABLE activities (
  tenant_id        uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  id               uuid NOT NULL,
  type_key         text NOT NULL,
  occurred_at      timestamptz NOT NULL DEFAULT now(),
  actor_type       text NOT NULL CHECK (actor_type IN ('contact', 'user', 'system', 'integration')),
  actor_contact_id uuid NULL,
  actor_user_id    uuid NULL,
  subject          text NULL,
  body             text NULL,
  source           text NULL,
  external_id      text NULL,
  payload          jsonb NOT NULL DEFAULT '{}',
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
  FOREIGN KEY (tenant_id, type_key) REFERENCES activity_types (tenant_id, key),
  FOREIGN KEY (tenant_id, actor_contact_id) REFERENCES contacts (tenant_id, id),
  FOREIGN KEY (tenant_id, actor_user_id) REFERENCES users (tenant_id, id),
  CHECK (
    (actor_type = 'contact' AND actor_contact_id IS NOT NULL AND actor_user_id IS NULL) OR
    (actor_type = 'user' AND actor_user_id IS NOT NULL AND actor_contact_id IS NULL) OR
    (actor_type IN ('system', 'integration') AND actor_contact_id IS NULL AND actor_user_id IS NULL)
  )
);
CREATE UNIQUE INDEX activities_external ON activities (tenant_id, source, external_id) WHERE external_id IS NOT NULL;
CREATE INDEX activities_occurred ON activities (tenant_id, occurred_at DESC);

-- Activities are history: only editable types (notes) may change, and only their text.
CREATE OR REPLACE FUNCTION app.activities_immutable() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.archived_at IS DISTINCT FROM OLD.archived_at AND
     (NEW.subject, NEW.body, NEW.payload, NEW.occurred_at) IS NOT DISTINCT FROM (OLD.subject, OLD.body, OLD.payload, OLD.occurred_at) THEN
    RETURN NEW; -- archiving is allowed
  END IF;
  IF NOT EXISTS (SELECT 1 FROM activity_types t WHERE t.tenant_id = OLD.tenant_id AND t.key = OLD.type_key AND t.editable) THEN
    RAISE EXCEPTION 'activities of type % cannot be edited', OLD.type_key USING ERRCODE = 'check_violation';
  END IF;
  IF (NEW.type_key, NEW.actor_type, NEW.actor_contact_id, NEW.actor_user_id, NEW.occurred_at)
     IS DISTINCT FROM (OLD.type_key, OLD.actor_type, OLD.actor_contact_id, OLD.actor_user_id, OLD.occurred_at) THEN
    RAISE EXCEPTION 'only the text of a note can be edited' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER activities_immutable BEFORE UPDATE ON activities
  FOR EACH ROW EXECUTE FUNCTION app.activities_immutable();

CREATE TABLE activity_associations (
  tenant_id   uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  activity_id uuid NOT NULL,
  record_id   uuid NOT NULL,
  occurred_at timestamptz NOT NULL,
  PRIMARY KEY (tenant_id, activity_id, record_id),
  FOREIGN KEY (tenant_id, activity_id) REFERENCES activities (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, record_id) REFERENCES record_registry (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX activity_associations_timeline ON activity_associations (tenant_id, record_id, occurred_at DESC);
SELECT app.enable_tenant_rls('activity_associations');

CREATE TABLE tasks (
  tenant_id        uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  id               uuid NOT NULL,
  title            text NOT NULL CHECK (length(title) BETWEEN 1 AND 500),
  description      text NULL,
  assignee_user_id uuid NOT NULL,
  due_at           timestamptz NULL,
  priority         text NOT NULL DEFAULT 'normal' CHECK (priority IN ('low', 'normal', 'high', 'urgent')),
  status           text NOT NULL DEFAULT 'open',
  status_category  text NOT NULL DEFAULT 'open' CHECK (status_category IN ('open', 'in_progress', 'done', 'cancelled')),
  completed_at     timestamptz NULL,
  source           text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'automation', 'alert')),
  source_ref       uuid NULL,
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
  FOREIGN KEY (tenant_id, assignee_user_id) REFERENCES users (tenant_id, id)
);
CREATE INDEX tasks_assignee ON tasks (tenant_id, assignee_user_id, status_category, due_at);
CREATE INDEX tasks_due ON tasks (tenant_id, due_at) WHERE status_category IN ('open', 'in_progress');

CREATE TABLE task_associations (
  tenant_id uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  task_id   uuid NOT NULL,
  record_id uuid NOT NULL,
  PRIMARY KEY (tenant_id, task_id, record_id),
  FOREIGN KEY (tenant_id, task_id) REFERENCES tasks (tenant_id, id) ON DELETE CASCADE,
  FOREIGN KEY (tenant_id, record_id) REFERENCES record_registry (tenant_id, id) ON DELETE CASCADE
);
CREATE INDEX task_associations_record ON task_associations (tenant_id, record_id);
SELECT app.enable_tenant_rls('task_associations');

CREATE TABLE pipelines (
  tenant_id   uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  id          uuid NOT NULL,
  name        text NOT NULL,
  is_default  boolean NOT NULL DEFAULT false,
  position    int NOT NULL DEFAULT 0,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  archived_at timestamptz NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, name)
);
CREATE UNIQUE INDEX pipelines_one_default ON pipelines (tenant_id) WHERE is_default AND archived_at IS NULL;
SELECT app.enable_tenant_rls('pipelines');

CREATE TABLE stages (
  tenant_id           uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  id                  uuid NOT NULL,
  pipeline_id         uuid NOT NULL,
  name                text NOT NULL,
  position            int NOT NULL,
  category            text NOT NULL CHECK (category IN ('open', 'won', 'lost')),
  default_probability numeric(5, 2) NULL CHECK (default_probability BETWEEN 0 AND 100),
  created_at          timestamptz NOT NULL DEFAULT now(),
  archived_at         timestamptz NULL,
  PRIMARY KEY (tenant_id, id),
  UNIQUE (tenant_id, pipeline_id, id),
  UNIQUE (tenant_id, pipeline_id, name),
  FOREIGN KEY (tenant_id, pipeline_id) REFERENCES pipelines (tenant_id, id)
);
SELECT app.enable_tenant_rls('stages');

CREATE TABLE leads (
  tenant_id               uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  id                      uuid NOT NULL,
  contact_id              uuid NOT NULL,
  account_id              uuid NULL,
  interest_product_id     uuid NULL,  -- foreign key to products is added with the Commerce module (M4b)
  interest_campaign       text NULL,
  interest_text           text NULL,
  source                  text NULL,
  channel                 text NULL,
  status                  text NOT NULL DEFAULT 'new',
  status_category         text NOT NULL DEFAULT 'new'
                            CHECK (status_category IN ('new', 'working', 'qualified', 'disqualified', 'converted')),
  disqualification_reason text NULL,
  score                   int NULL,
  converted_deal_id       uuid NULL,
  converted_at            timestamptz NULL,
  owner_id                uuid NULL,
  search_text             text NOT NULL DEFAULT '',
  external_ids            jsonb NOT NULL DEFAULT '{}',
  custom                  jsonb NOT NULL DEFAULT '{}',
  custom_encrypted        jsonb NOT NULL DEFAULT '{}',
  version                 int NOT NULL DEFAULT 1,
  created_at              timestamptz NOT NULL DEFAULT now(),
  created_by              uuid NULL,
  updated_at              timestamptz NOT NULL DEFAULT now(),
  updated_by              uuid NULL,
  archived_at             timestamptz NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, owner_id) REFERENCES users (tenant_id, id),
  CHECK ((status_category = 'converted') = (converted_deal_id IS NOT NULL))
);
CREATE INDEX leads_contact ON leads (tenant_id, contact_id);
CREATE INDEX leads_status ON leads (tenant_id, status_category, owner_id);
CREATE INDEX leads_search ON leads USING gin (search_text gin_trgm_ops);

CREATE TABLE deals (
  tenant_id           uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  id                  uuid NOT NULL,
  name                text NOT NULL CHECK (length(name) BETWEEN 1 AND 500),
  account_id          uuid NULL,
  primary_contact_id  uuid NOT NULL,
  source_lead_id      uuid NULL,
  pipeline_id         uuid NOT NULL,
  stage_id            uuid NOT NULL,
  amount_minor        bigint NULL,
  currency            char(3) NOT NULL,
  expected_close_date date NULL,
  probability         numeric(5, 2) NULL CHECK (probability BETWEEN 0 AND 100),
  status_category     text NOT NULL DEFAULT 'open' CHECK (status_category IN ('open', 'won', 'lost')),
  lost_reason         text NULL,
  last_activity_at    timestamptz NULL,
  stage_entered_at    timestamptz NOT NULL DEFAULT now(),
  owner_id            uuid NULL,
  search_text         text NOT NULL DEFAULT '',
  external_ids        jsonb NOT NULL DEFAULT '{}',
  custom              jsonb NOT NULL DEFAULT '{}',
  custom_encrypted    jsonb NOT NULL DEFAULT '{}',
  version             int NOT NULL DEFAULT 1,
  created_at          timestamptz NOT NULL DEFAULT now(),
  created_by          uuid NULL,
  updated_at          timestamptz NOT NULL DEFAULT now(),
  updated_by          uuid NULL,
  archived_at         timestamptz NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, account_id) REFERENCES accounts (tenant_id, id),
  FOREIGN KEY (tenant_id, primary_contact_id) REFERENCES contacts (tenant_id, id),
  FOREIGN KEY (tenant_id, source_lead_id) REFERENCES leads (tenant_id, id),
  FOREIGN KEY (tenant_id, pipeline_id, stage_id) REFERENCES stages (tenant_id, pipeline_id, id),
  FOREIGN KEY (tenant_id, owner_id) REFERENCES users (tenant_id, id)
);
CREATE INDEX deals_pipeline ON deals (tenant_id, pipeline_id, stage_id);
CREATE INDEX deals_owner ON deals (tenant_id, owner_id, status_category);
CREATE INDEX deals_account ON deals (tenant_id, account_id);
CREATE INDEX deals_contact ON deals (tenant_id, primary_contact_id);
CREATE INDEX deals_search ON deals USING gin (search_text gin_trgm_ops);
CREATE INDEX deals_custom ON deals USING gin (custom jsonb_path_ops);

ALTER TABLE leads ADD FOREIGN KEY (tenant_id, converted_deal_id) REFERENCES deals (tenant_id, id);
CREATE UNIQUE INDEX leads_converted_deal ON leads (tenant_id, converted_deal_id) WHERE converted_deal_id IS NOT NULL;

-- A converted lead is read-only (archiving aside).
CREATE OR REPLACE FUNCTION app.leads_converted_readonly() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  IF OLD.status_category = 'converted' AND NEW.archived_at IS NOT DISTINCT FROM OLD.archived_at THEN
    RAISE EXCEPTION 'a converted lead is read-only' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END $$;
CREATE TRIGGER leads_converted_readonly BEFORE UPDATE ON leads
  FOR EACH ROW EXECUTE FUNCTION app.leads_converted_readonly();

CREATE TABLE deal_contacts (
  tenant_id        uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  id               uuid NOT NULL,
  deal_id          uuid NOT NULL,
  contact_id       uuid NOT NULL,
  role             text NOT NULL DEFAULT 'influencer',
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
  FOREIGN KEY (tenant_id, deal_id) REFERENCES deals (tenant_id, id),
  FOREIGN KEY (tenant_id, contact_id) REFERENCES contacts (tenant_id, id)
);
CREATE UNIQUE INDEX deal_contacts_role ON deal_contacts (tenant_id, deal_id, contact_id, role) WHERE archived_at IS NULL;
CREATE INDEX deal_contacts_contact ON deal_contacts (tenant_id, contact_id);

CREATE TABLE deal_stage_history (
  tenant_id          uuid NOT NULL REFERENCES tenant_directory (tenant_id),
  id                 uuid NOT NULL,
  deal_id            uuid NOT NULL,
  from_stage_id      uuid NULL,
  to_stage_id        uuid NOT NULL,
  changed_at         timestamptz NOT NULL DEFAULT now(),
  changed_by         uuid NULL,
  time_in_from_stage interval NULL,
  PRIMARY KEY (tenant_id, id),
  FOREIGN KEY (tenant_id, deal_id) REFERENCES deals (tenant_id, id)
);
CREATE INDEX deal_stage_history_deal ON deal_stage_history (tenant_id, deal_id, changed_at);
SELECT app.enable_tenant_rls('deal_stage_history');

-- RLS, registry and updated_at triggers for every object table.
DO $$
DECLARE r record;
BEGIN
  FOR r IN SELECT * FROM (VALUES
    ('accounts', 'account'), ('contacts', 'contact'), ('account_contacts', 'account_contact'),
    ('activities', 'activity'), ('tasks', 'task'), ('leads', 'lead'), ('deals', 'deal'),
    ('deal_contacts', 'deal_contact')
  ) AS t(tbl, obj) LOOP
    PERFORM app.enable_tenant_rls(r.tbl::regclass);
    EXECUTE format('CREATE TRIGGER %I BEFORE INSERT OR DELETE ON %I FOR EACH ROW EXECUTE FUNCTION app.register_record(%L)',
                   r.tbl || '_registry', r.tbl, r.obj);
    EXECUTE format('CREATE TRIGGER %I BEFORE UPDATE ON %I FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at()',
                   r.tbl || '_touch', r.tbl);
  END LOOP;
END $$;

CREATE TRIGGER records_touch BEFORE UPDATE ON records FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
CREATE TRIGGER tenants_touch BEFORE UPDATE ON tenants FOR EACH ROW EXECUTE FUNCTION app.touch_updated_at();
