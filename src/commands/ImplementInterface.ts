import log from "../log";
import * as ts from "typescript";
import { getMemberNames, convertPositionToLocation, getNodesContainingPoint } from "../utilities/languageUtilities";
import * as Bluebird from "bluebird";
import { TsunamiContext } from "../Context";
import { CodeEdit } from "../protocol/types";
import { Command, CommandDefinition } from "../Command";

interface ImplementInterfaceCommand extends Command {
    arguments: {
        filename: string;
        position: number;
    };
}

function emitCallSignature(checker: ts.TypeChecker, signature: ts.Signature): string {
    const nameAndTypeTuples = signature.getParameters().map(param => [
        param.getName(),
        checker.typeToString(checker.getTypeAtLocation(param.getDeclarations()[0]))
    ]);

    const returnType = checker.typeToString(signature.getReturnType());

    return `(${nameAndTypeTuples.map(([name, type]) => name + ": " + type).join(", ")}): ${returnType}`;
}

function isCallableType(type: ts.Type): boolean {
    return type.getCallSignatures().length > 0;
}

export class ImplementInterfaceCommandDefinition implements CommandDefinition<ImplementInterfaceCommand, CodeEdit | null> {
    public predicate(command: Command): command is ImplementInterfaceCommand {
        return command.command === "IMPLEMENT_INTERFACE";
    }

    public async processor(context: TsunamiContext, command: ImplementInterfaceCommand): Bluebird<CodeEdit | null> {
        const { filename, position } = command.arguments;
        const program = await context.getProgram();
        const sourceFile = await program.getSourceFile(filename);
        const containingNodes = getNodesContainingPoint(sourceFile, position);
        const checker = program.getTypeChecker();

        const classNode = containingNodes.filter(node => node.kind === ts.SyntaxKind.ClassDeclaration)[0] as ts.ClassDeclaration;
        const childNames = new Set<string>(getMemberNames(classNode));

        classNode.getChildren().forEach((child: any) => {
            if (child.name != null) {
                childNames.add(child.getName());
            }
        });

        const expressions = containingNodes.filter(
            node => node.kind === ts.SyntaxKind.ExpressionWithTypeArguments
        ) as ts.ExpressionWithTypeArguments[];

        if (expressions.length !== 1) {
            return null;
        }

        const node = expressions[0];
        const props = checker.getTypeAtLocation(node).getProperties();

        const methodDescriptors = props.filter(prop => !childNames.has(prop.getName())).map(
            prop => {
                let result = prop.getName();
                const propType = checker.getTypeAtLocation(prop.getDeclarations()[0]);

                if (isCallableType(propType)) {
                    result += emitCallSignature(checker, propType.getCallSignatures()[0]);
                    result += " {}";
                } else {
                    result += ": " + checker.typeToString(propType) + ";";
                }

                return result;
            }
        );

        if (methodDescriptors.length === 0) {
            return null;
        }

        const start = classNode.getEnd() - 2;

        return {
            start: convertPositionToLocation(sourceFile, start),
            end: convertPositionToLocation(sourceFile, start + 1),
            newText: "\n" + methodDescriptors.join("\n") + "\n"
        } as CodeEdit;
    }
}
