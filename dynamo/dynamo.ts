import { MappingTemplateVersion } from "../mapping-template"
import { TemplateBuilder } from "../builder"
import { Reference, Expression, Method } from "../vtl/reference"
import { ConditionExpression, Query } from "./dynamo-conditions"
import { DataSource } from "../appsync/data-source"
import { DynamoDBUtils } from "../appsync/dynamodb-utils"
import { Util } from "../appsync/util"
import { Update, UpdateExpression } from "./dynamo-update"

export interface PrimaryKey {
    readonly [k: string]: Expression
}

export interface AttributeValues {
    // Must be a map. Again, hard to verify types.
    readonly projecting?: Reference
    readonly values: {
        readonly [k: string]: Expression
    }
}

export interface PutItemProps {
    key: PrimaryKey
    attributes?: AttributeValues
    cond?: ConditionExpression
}

export interface UpdateItemProps {
    readonly key: PrimaryKey
    readonly update: UpdateExpression
    readonly cond?: ConditionExpression
}

export interface GetItemProps {
    readonly key: PrimaryKey
}

export interface DeleteItemProps {
    readonly key: PrimaryKey
    readonly cond?: ConditionExpression
}

export interface QueryProps {
    readonly index?: string
    readonly nextToken?: string
    readonly limit?: number
    readonly scanIndexForward?: boolean
    readonly consistentRead?: boolean
}

export enum TransactionOperation {
    PutItem = "PutItem",
    UpdateItem = "UpdateItem",
    DeleteItem = "DeleteItem",
    //ConditionCheck = "ConditionCheck",
}

export interface TransactWriteItemProps {
    readonly tableName: string
    readonly key: PrimaryKey
    readonly op: TransactionOperation
    readonly returnValuesOnConditionCheckFailure?: boolean
    readonly cond?: ConditionExpression
    // Valid only if op is Operation.PutItem
    readonly attributes?: AttributeValues
    // Valid only if op is Operation.UpdateItem
    readonly update?: UpdateExpression
}

export class DynamoDbRequestUtils {
    public constructor(readonly builder: TemplateBuilder) {}

    private keyToDynamo(pk: PrimaryKey): PrimaryKey {
        return Object.entries(pk).reduce((acc, [k, v]) => {
            if (!(v instanceof Method) || !v.name.includes("util.dynamodb")) {
                v = new DynamoDBUtils(this.builder).toDynamoDB(v)
            }
            return { ...acc, [k]: v }
        }, {} as PrimaryKey)
    }

    private prepareAttributes(attrs?: AttributeValues): Reference | undefined {
        if (!attrs) {
            return undefined
        }
        const values = this.builder.map(attrs.projecting)
        Object.entries(attrs.values).forEach(([k, v]) => new Util(this.builder).quiet(values?.put(k, v.consume())))
        return new DynamoDBUtils(this.builder).toMapValues(values)
    }

    public putItem(props: PutItemProps): DataSource {
        const values = this.prepareAttributes(props.attributes)
        return new DataSource(this.builder, {
            operation: "PutItem",
            version: MappingTemplateVersion.V1,
            key: this.keyToDynamo(props.key),
            ...(values ? { attributeValues: values } : {}),
            ...(props.cond ? { condition: props.cond.resolve(this.builder) } : {}),
        })
    }

    public updateItem(props: UpdateItemProps): DataSource {
        return new DataSource(this.builder, {
            operation: "UpdateItem",
            version: MappingTemplateVersion.V1,
            key: this.keyToDynamo(props.key),
            update: new Update(props.update).resolve(this.builder),
            ...(props.cond ? { condition: props.cond.resolve(this.builder) } : {}),
        })
    }

    public getItem(props: GetItemProps): DataSource {
        return new DataSource(this.builder, {
            operation: "GetItem",
            version: MappingTemplateVersion.V1,
            key: this.keyToDynamo(props.key),
        })
    }

    public deleteItem(props: DeleteItemProps): DataSource {
        return new DataSource(this.builder, {
            operation: "DeleteItem",
            version: MappingTemplateVersion.V1,
            key: this.keyToDynamo(props.key),
            ...(props.cond ? { condition: props.cond.resolve(this.builder) } : {}),
        })
    }

    public query(q: Query, props?: QueryProps): DataSource {
        return new DataSource(this.builder, {
            operation: "Query",
            version: MappingTemplateVersion.V1,
            query: q.resolve(this.builder),
            ...(props?.index !== undefined ? { index: props.index } : {}),
            ...(props?.consistentRead !== undefined ? { consistentRead: props.consistentRead } : {}),
            ...(props?.limit !== undefined ? { limit: props.limit } : {}),
            ...(props?.nextToken !== undefined ? { nextToken: props.nextToken } : {}),
            ...(props?.scanIndexForward !== undefined ? { scanIndexForward: props.scanIndexForward } : {}),
        })
    }

    public transactWrite(...tx: TransactWriteItemProps[]): DataSource {
        const transactItems = tx.map(item => ({
            table: item.tableName,
            key: this.keyToDynamo(item.key),
            operation: item.op,
            ...(item.cond
                ? {
                      condition: {
                          returnValuesOnConditionCheckFailure: item.returnValuesOnConditionCheckFailure,
                          ...item.cond.resolve(this.builder),
                      },
                  }
                : {}),
            ...(item.op === TransactionOperation.PutItem
                ? {
                      attributeValues: this.prepareAttributes(item.attributes),
                  }
                : {}),
            ...(item.op === TransactionOperation.DeleteItem
                ? {
                      update: new Update(item.update || {}).resolve(this.builder),
                  }
                : {}),
        }))

        return new DataSource(this.builder, {
            version: MappingTemplateVersion.V2,
            operation: "TransactWriteItems",
            transactItems,
        })
    }
}
