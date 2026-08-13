import { describe, expect, test } from "vitest";

import {
  classifyCanadaPostCandidates,
  parseJifengOfflineLogistics,
  parseJifengWarehouses,
} from "@/integrations/jifeng/resources";
import type { JifengOfflineLogistics } from "@/integrations/jifeng/types";

describe("Jifeng read-only resources", () => {
  test("validates and returns the official warehouse fields", () => {
    expect(
      parseJifengWarehouses([
        {
          address: "123 Warehouse Road",
          area: "Scarborough",
          city: "Toronto",
          code: "CA-YYZ",
          contactPerson: "Warehouse Operator",
          country: "CA",
          email: "warehouse@example.test",
          id: 42,
          isAuth: true,
          name: "Toronto Warehouse",
          orderReceiveStatus: 1,
          phone: "+1-555-0100",
          postCode: "M1B 2K3",
          province: "ON",
          receiveStatus: 1,
          remark: "Authorized",
          selfSending: 1,
          timeZone: "America/Toronto",
          type: 1,
          ignoredByBusinessModel: "unknown field",
        },
      ]),
    ).toEqual([
      {
        address: "123 Warehouse Road",
        area: "Scarborough",
        city: "Toronto",
        code: "CA-YYZ",
        contactPerson: "Warehouse Operator",
        country: "CA",
        email: "warehouse@example.test",
        id: 42,
        isAuth: true,
        name: "Toronto Warehouse",
        orderReceiveStatus: 1,
        phone: "+1-555-0100",
        postCode: "M1B 2K3",
        province: "ON",
        receiveStatus: 1,
        remark: "Authorized",
        selfSending: 1,
        timeZone: "America/Toronto",
        type: 1,
      },
    ]);
  });

  test("validates the official offline-logistics page and returns its rows", () => {
    expect(
      parseJifengOfflineLogistics({
        page: {
          heads: [{ key: "name", value: "Name" }],
          pageNo: 1,
          pageSize: 300,
          rows: [
            { code: "carrier-code-from-api", id: 17, name: "Canada Post" },
          ],
          totalPage: 1,
          totalSize: 1,
        },
      }),
    ).toEqual([
      { code: "carrier-code-from-api", id: 17, name: "Canada Post" },
    ]);
  });

  test.each(["Canada Post", " canada post ", "加拿大邮政"])(
    "recognizes the explicit Canada Post name %s",
    (name) => {
      const channel = { code: "unconfirmed-api-code", id: 17, name };

      expect(classifyCanadaPostCandidates([channel])).toEqual({
        candidate: channel,
        candidates: [channel],
        status: "MATCHED",
      });
    },
  );

  test("does not infer Canada Post from an unconfirmed carrier code or default to the first channel", () => {
    const channels: JifengOfflineLogistics[] = [
      { code: "CANADA_POST", id: 1, name: "Unrelated carrier" },
      { code: "OTHER", id: 2, name: "Another carrier" },
    ];

    expect(classifyCanadaPostCandidates(channels)).toEqual({
      candidates: [],
      status: "AMBIGUOUS",
    });
  });

  test("returns ambiguity instead of choosing among multiple explicit candidates", () => {
    const channels: JifengOfflineLogistics[] = [
      { code: "api-code-1", id: 1, name: "Canada Post" },
      { code: "api-code-2", id: 2, name: "加拿大邮政" },
    ];

    expect(classifyCanadaPostCandidates(channels)).toEqual({
      candidates: channels,
      status: "AMBIGUOUS",
    });
  });
});
