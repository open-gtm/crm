/**
 * The patterns the CLI checks and parses its arguments with, each named once. They catch a typo before
 * a request is made; the server stays the authority on what is valid.
 */

/** A public ID is a short prefix, an underscore and 26 base-62 characters. */
const id = (prefix: string) => new RegExp(`^${prefix}_[0-9A-Za-z]{26}$`);

export const KEY_ID = id("key");
export const FILE_ID = id("file");
export const USER_ID = id("usr");
/** A person (usr_…) or a service account (svc_…). */
export const MEMBER_ID = id("(usr|svc)");
export const SESSION_ID = id("ses");
export const CONNECTED_APP_ID = id("ogr");
export const WEBHOOK_ID = id("whk");
export const AUTOMATION_ID = id("auto");
/** A record of any object: the object's own prefix, 2 to 8 letters. */
export const RECORD_ID = id("[a-z]{2,8}");

export const OBJECT_NAME = /^[a-z][a-z0-9_]{0,62}$/;
/** A role key or a role ID. Looser than the server's rule for new keys, since it takes either. */
export const ROLE_REF = /^[a-z0-9_]{1,64}$/i;
export const PACK_NAME = /^[a-z][a-z0-9-]{1,62}$/;
export const PACK_VERSION = /^\d{1,6}\.\d{1,6}\.\d{1,6}$/;

/** `field=value` or `field[op]=value`, as --where and --filter take them. Groups: field, op, value. */
export const FIELD_CONDITION = /^([a-z0-9_.]+)(?:\[([a-z_]+)\])?=(.*)$/s;
/** A `filter[field]` or `filter[field][op]` query key. Groups: field, op. */
export const FILTER_KEY = /^filter\[([a-z0-9_.]+)\](?:\[([a-z_]+)\])?$/;
/** `object:read|write|archive=word`, for a role's object access. Groups: object, action, setting. */
export const OBJECT_ACCESS_RULE = /^([a-z][a-z0-9_]*):(read|write|archive)=(\w+)$/;
/** `object.field=none|read|inherit`, for a role's field access. Groups: object, field, setting. */
export const FIELD_ACCESS_RULE = /^([a-z][a-z0-9_]*)\.([a-z][a-z0-9_]*)=(none|read|inherit)$/;

/** One or two digits, as a rating typed in a CSV or on the command line. */
export const SHORT_NUMBER = /^\d{1,2}$/;
export const YES = /^y(es)?$/i;
