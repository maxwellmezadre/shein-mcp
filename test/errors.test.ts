import { describe, expect, test } from "bun:test";
import {
  LOGIN_HINT,
  ParseError,
  SheinApiError,
  SheinAuthError,
  SheinHttpError,
  SheinRiskControlError,
} from "../src/core/errors.js";

describe("error taxonomy", () => {
  test("auth errors always carry the login hint", () => {
    const error = new SheinAuthError("A Shein não aceitou a sessão.");
    expect(error.message).toContain(LOGIN_HINT);
    expect(LOGIN_HINT).toContain("shein login");
    expect(error.name).toBe("SheinAuthError");
  });

  test("api errors keep the Shein code and the path for branching", () => {
    const error = new SheinApiError("100102", "Erro ao solicitar o parâmetro.", "/bff-api/order/list");
    expect(error.code).toBe("100102");
    expect(error.path).toBe("/bff-api/order/list");
    expect(error.message).toContain("100102");
    expect(error.message).toContain("/bff-api/order/list");
  });

  test("http errors expose the status; risk-control and parse errors are distinct classes", () => {
    expect(new SheinHttpError(503, "x").status).toBe(503);
    expect(new SheinRiskControlError("x")).toBeInstanceOf(Error);
    expect(new ParseError("O gbRawData sumiu.").message).toContain("shein doctor");
  });
});
