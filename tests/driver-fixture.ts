import type { Controller, ControllerContext, ToolArguments } from "../src/contracts.ts";
import { argumentValidator } from "../src/tool-contract.ts";

// Direct provider fixtures enter through the same argument-validation boundary as core.
export async function call(controller: Controller, args: ToolArguments, context: ControllerContext) {
  return controller.execute(argumentValidator(controller.tool)(args), context);
}
