import { describe, it, expect } from "vitest";
import {
  q,
  createQueryBuilder,
  where,
  createTypedQueryBuilder,
  createFieldBuilder,
} from "@/client/query-builder";

describe("Query Builder", () => {
  describe("q (basic query builder)", () => {
    describe("Equality operators", () => {
      it("should build eq filter", () => {
        expect(q.eq("name", "John")).toBe('name=="John"');
      });

      it("should build neq filter", () => {
        expect(q.neq("status", "inactive")).toBe('status!="inactive"');
      });

      it("should handle numeric values", () => {
        expect(q.eq("age", 25)).toBe("age==25");
      });

      it("should handle boolean values", () => {
        expect(q.eq("active", true)).toBe("active==true");
      });
    });

    describe("Comparison operators", () => {
      it("should build gt filter", () => {
        expect(q.gt("age", 18)).toBe("age>18");
      });

      it("should build gte filter", () => {
        expect(q.gte("score", 90)).toBe("score>=90");
      });

      it("should build lt filter", () => {
        expect(q.lt("price", 100)).toBe("price<100");
      });

      it("should build lte filter", () => {
        expect(q.lte("quantity", 0)).toBe("quantity<=0");
      });
    });

    describe("String operators", () => {
      it("should build like filter", () => {
        expect(q.like("name", "%john%")).toBe('name=like="%john%"');
      });

      it("should build startsWith filter", () => {
        expect(q.startsWith("email", "admin")).toBe('email=like="admin%"');
      });

      it("should build endsWith filter", () => {
        expect(q.endsWith("file", ".pdf")).toBe('file=like="%.pdf"');
      });

      it("should build contains filter", () => {
        expect(q.contains("description", "important")).toBe('description=like="%important%"');
      });
    });

    describe("Set operators", () => {
      it("should build in filter", () => {
        expect(q.in("status", ["active", "pending"])).toBe(
          'status=in=("active","pending")'
        );
      });

      it("should build out filter", () => {
        expect(q.out("role", ["guest", "banned"])).toBe(
          'role=out=("guest","banned")'
        );
      });

      it("should handle numeric arrays", () => {
        expect(q.in("id", [1, 2, 3])).toBe("id=in=(1,2,3)");
      });
    });

    describe("NULL operators", () => {
      it("should build isNull filter", () => {
        expect(q.isNull("deletedAt")).toBe("deletedAt=isnull=true");
      });

      it("should build isNotNull filter", () => {
        expect(q.isNotNull("email")).toBe("email=isnull=false");
      });
    });

    describe("Logical operators", () => {
      it("should build AND filter", () => {
        const filter = q.and(q.eq("status", "active"), q.gt("age", 18));
        expect(filter).toBe('(status=="active");(age>18)');
      });

      it("should build OR filter", () => {
        const filter = q.or(q.eq("role", "admin"), q.eq("role", "moderator"));
        expect(filter).toBe('(role=="admin"),(role=="moderator")');
      });

      it("should handle nested logical operators", () => {
        const filter = q.and(
          q.or(q.eq("status", "active"), q.eq("status", "pending")),
          q.gt("score", 50)
        );
        expect(filter).toBe(
          '((status=="active"),(status=="pending"));(score>50)'
        );
      });
    });

    describe("between operator", () => {
      it("should build between filter", () => {
        expect(q.between("age", 18, 65)).toBe("(age>=18);(age<=65)");
      });
    });

    describe("raw operator", () => {
      it("should pass through raw expressions", () => {
        expect(q.raw("custom=op=value")).toBe("custom=op=value");
      });
    });

    describe("Value escaping", () => {
      it("should escape strings with quotes", () => {
        expect(q.eq("name", 'John "Jack" Doe')).toBe(
          'name=="John \\"Jack\\" Doe"'
        );
      });

      it("should escape strings with backslashes", () => {
        expect(q.eq("path", "C:\\Users")).toBe('path=="C:\\\\Users"');
      });

      it("should handle special characters", () => {
        expect(q.eq("email", "user@example.com")).toBe(
          'email=="user@example.com"'
        );
      });
    });
  });

  describe("createQueryBuilder / where", () => {
    it("should create fluent query builder", () => {
      const filter = where().gte("age", 18).and(q.eq("status", "active")).build();
      expect(filter).toBe('(age>=18);(status=="active")');
    });

    it("should handle multiple conditions", () => {
      const filter = where()
        .eq("name", "John")
        .and(q.gt("age", 21))
        .and(q.in("role", ["admin", "user"]))
        .build();
      expect(filter).toBe(
        '(name=="John");(age>21);(role=in=("admin","user"))'
      );
    });

    it("should support or conditions", () => {
      const filter = where()
        .eq("status", "active")
        .or(q.eq("status", "pending"))
        .build();
      expect(filter).toBe('(status=="active"),(status=="pending")');
    });

    it("should support mixed and/or", () => {
      const filter = where()
        .eq("type", "user")
        .and(q.eq("status", "active"))
        .or(q.eq("role", "admin"))
        .build();
      // The AND conditions are grouped before OR
      expect(filter).toBe(
        '(type=="user";status=="active"),(role=="admin")'
      );
    });

    it("should be aliased as createQueryBuilder", () => {
      // createQueryBuilder takes an optional field prefix
      const filter = createQueryBuilder().eq("name", "Test").build();
      expect(filter).toBe('name=="Test"');
    });
  });

  describe("createFieldBuilder", () => {
    it("should create field-specific builder", () => {
      const age = createFieldBuilder<number>("age");
      
      expect(age.eq(25)).toBe("age==25");
      expect(age.gt(18)).toBe("age>18");
      expect(age.between(18, 65)).toBe("(age>=18);(age<=65)");
    });

    it("should work with string fields", () => {
      const name = createFieldBuilder<string>("name");
      
      expect(name.eq("John")).toBe('name=="John"');
      expect(name.contains("john")).toBe('name=like="%john%"');
    });

    it("should work with nullable fields", () => {
      const deletedAt = createFieldBuilder("deletedAt");
      
      expect(deletedAt.isNull()).toBe("deletedAt=isnull=true");
      expect(deletedAt.isNotNull()).toBe("deletedAt=isnull=false");
    });
  });

  describe("createTypedQueryBuilder", () => {
    interface User {
      id: string;
      name: string;
      email: string;
      age: number;
      role: "admin" | "user" | "guest";
      createdAt: Date;
      deletedAt: Date | null;
    }

    it("should create typed builder with field access", () => {
      const users = createTypedQueryBuilder<User>();

      expect(users.name.eq("John")).toBe('name=="John"');
      expect(users.age.gt(18)).toBe("age>18");
      expect(users.role.in(["admin", "user"])).toBe('role=in=("admin","user")');
    });

    it("should maintain type safety", () => {
      const users = createTypedQueryBuilder<User>();

      // These should all be valid
      const filters = [
        users.id.eq("123"),
        users.name.contains("john"),
        users.email.endsWith("@example.com"),
        users.age.between(18, 65),
        users.role.eq("admin"),
        users.createdAt.gt(new Date("2024-01-01")),
        users.deletedAt.isNull(),
      ];

      expect(filters).toHaveLength(7);
      filters.forEach((f) => expect(typeof f).toBe("string"));
    });

    it("should allow combining typed queries", () => {
      const users = createTypedQueryBuilder<User>();

      const filter = q.and(
        users.role.eq("admin"),
        users.age.gte(21),
        users.deletedAt.isNull()
      );

      expect(filter).toBe(
        '(role=="admin");(age>=21);(deletedAt=isnull=true)'
      );
    });
  });

  describe("Complex real-world queries", () => {
    it("should build user search query", () => {
      const filter = q.and(
        q.or(q.contains("name", "john"), q.contains("email", "john")),
        q.eq("status", "active"),
        q.isNull("deletedAt")
      );

      expect(filter).toBe(
        '((name=like="%john%"),(email=like="%john%"));(status=="active");(deletedAt=isnull=true)'
      );
    });

    it("should build date range query", () => {
      const startDate = new Date("2024-01-01").toISOString();
      const endDate = new Date("2024-12-31").toISOString();

      const filter = q.and(
        q.gte("createdAt", startDate),
        q.lte("createdAt", endDate)
      );

      expect(filter).toContain("createdAt>=");
      expect(filter).toContain("createdAt<=");
    });

    it("should build pagination filter", () => {
      const filter = q.and(
        q.gt("id", "last-seen-id"),
        q.eq("status", "published")
      );

      expect(filter).toBe('(id>"last-seen-id");(status=="published")');
    });

    it("should build multi-tenant query", () => {
      const filter = q.and(
        q.eq("tenantId", "tenant-123"),
        q.or(q.eq("visibility", "public"), q.eq("ownerId", "user-456"))
      );

      expect(filter).toBe(
        '(tenantId=="tenant-123");((visibility=="public"),(ownerId=="user-456"))'
      );
    });
  });
});
