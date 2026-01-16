# Filtering

Concave uses an RSQL-like syntax for filtering resources.

## Basic Syntax

```
field==value        # Equals
field!=value        # Not equals
field>value         # Greater than
field>=value        # Greater than or equal
field<value         # Less than
field<=value        # Less than or equal
field=in=(a,b,c)    # In list
field=out=(a,b,c)   # Not in list
field%=pattern      # LIKE pattern
field!%=pattern     # NOT LIKE pattern
field=isnull=true   # Is null
```

## Compound Filters

```
# AND (semicolon)
status=="active";age>18

# OR (comma)
role=="admin",role=="moderator"

# Grouping (parentheses)
(status=="active";age>18),(role=="admin")
```

## Examples

```bash
# Get active users
GET /users?filter=status=="active"

# Get users older than 18
GET /users?filter=age>18

# Get users with specific roles
GET /users?filter=role=in=("admin","moderator")

# Complex filter
GET /users?filter=(status=="active";age>18),(role=="admin")
```

## Custom Operators

You can define custom operators in your resource config:

```typescript
useResource(usersTable, {
  id: usersTable.id,
  customOperators: {
    "=contains=": {
      // SQL conversion for database queries
      convert: (lhs, rhs) => sql`${lhs} LIKE '%' || ${rhs} || '%'`,
      // JavaScript execution for subscription filtering
      execute: (lhs, rhs) => String(lhs).includes(String(rhs)),
    },
    "=startswith=": {
      convert: (lhs, rhs) => sql`${lhs} LIKE ${rhs} || '%'`,
      execute: (lhs, rhs) => String(lhs).startsWith(String(rhs)),
    },
    "=between=": {
      convert: (lhs, rhs) => sql`${lhs} BETWEEN ${rhs[0]} AND ${rhs[1]}`,
      execute: (lhs, rhs) => lhs >= rhs[0] && lhs <= rhs[1],
    },
  },
});
```

Usage:

```bash
# Contains
GET /users?filter=name=contains="john"

# Starts with
GET /users?filter=email=startswith="admin"

# Between
GET /users?filter=age=between=(18,65)
```

## Value Types

```
# Strings (quoted)
name=="John Doe"

# Numbers (unquoted)
age==25

# Booleans
active==true

# Null
deletedAt=isnull=true

# Arrays
tags=in=("tech","news")

# Dates (ISO format in quotes)
createdAt>"2024-01-01T00:00:00Z"
```

## Escaping

Special characters in strings should be escaped:

```
name=="John \"Johnny\" Doe"
path=="C:\\Users\\John"
```
