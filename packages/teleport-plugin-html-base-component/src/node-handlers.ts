import {
  UIDLNode,
  UIDLElementNode,
  HastNode,
  HTMLComponentGeneratorError,
  UIDLAttributeValue,
  UIDLPropDefinition,
  UIDLStateDefinition,
  UIDLDynamicReference,
  UIDLStyleDefinitions,
  HastText,
  ComponentUIDL,
  ChunkType,
  FileType,
  ChunkDefinition,
  UIDLDependency,
  UIDLStyleValue,
  GeneratorOptions,
  UIDLRouteDefinitions,
  ComponentPlugin,
  ComponentStructure,
  UIDLComponentOutputOptions,
  UIDLElement,
  ElementsLookup,
  UIDLConditionalNode,
  PropDefaultValueTypes,
  UIDLCMSListRepeaterNode,
} from '@teleporthq/teleport-types'
import { join, relative } from 'path'
import { HASTBuilders, HASTUtils, ASTUtils } from '@teleporthq/teleport-plugin-common'
import { GenericUtils, StringUtils, UIDLUtils } from '@teleporthq/teleport-shared'
import { staticNode } from '@teleporthq/teleport-uidl-builders'
import { createCSSPlugin } from '@teleporthq/teleport-plugin-css'
import { generateUniqueKeys, createNodesLookup } from '@teleporthq/teleport-uidl-resolver'
import { DEFAULT_COMPONENT_CHUNK_NAME } from './constants'

const isValidURL = (url: string) => {
  try {
    /* tslint:disable:no-unused-expression */
    new URL(url)
    return true
  } catch (error) {
    return false
  }
}

const addNodeToLookup = (
  key: string,
  tag: HastNode | HastText | Array<HastNode | HastText>,
  nodesLoookup: Record<string, HastNode | HastText | Array<HastNode | HastText>>
) => {
  // In html code-generation we combine the nodes of the component that is being consumed with the current component.
  // As html can't load the component at runtime like react or any other frameworks. So, we merge the component as a standalone
  // component in the current component.
  const currentLookup = nodesLoookup[key]
  if (currentLookup) {
    if (Array.isArray(currentLookup)) {
      Array.isArray(tag) ? currentLookup.push(...tag) : currentLookup.push(tag)
    } else {
      nodesLoookup[key] = Array.isArray(tag) ? [currentLookup, ...tag] : [currentLookup, tag]
    }

    return
  }

  nodesLoookup[key] = tag
}

type NodeToHTML<NodeType, ReturnType> = (
  node: NodeType,
  componentName: string,
  nodesLookup: Record<string, HastNode | HastText | Array<HastNode | HastText>>,
  propDefinitions: Record<string, UIDLPropDefinition>,
  stateDefinitions: Record<string, UIDLStateDefinition>,
  subComponentOptions: {
    externals: Record<string, ComponentUIDL>
    plugins: ComponentPlugin[]
  },
  structure: {
    chunks: ChunkDefinition[]
    dependencies: Record<string, UIDLDependency>
    options: GeneratorOptions
    outputOptions: UIDLComponentOutputOptions
  },
  /**
   * This param is just to be able to handle CMS array mappers/Repeater nodes. A bit hacky, better support should be implemented
   */
  resolvedExpressions?: {
    expressions: Record<string, UIDLPropDefinition>
    currentIndex: number
  }
) => ReturnType

export const generateHtmlSyntax: NodeToHTML<
  UIDLNode,
  Promise<HastNode | HastText | Array<HastNode | HastText>>
> = async (
  node,
  compName,
  nodesLookup,
  propDefinitions,
  stateDefinitions,
  subComponentOptions,
  structure,
  resolvedExpressions
) => {
  switch (node.type) {
    case 'inject':
    case 'raw':
      return HASTBuilders.createTextNode(node.content.toString())

    case 'static':
      return HASTBuilders.createTextNode(StringUtils.encode(node.content.toString()))

    case 'slot':
      return HASTBuilders.createHTMLNode(node.type)

    case 'element':
      const elementNode = await generateElementNode(
        node,
        compName,
        nodesLookup,
        propDefinitions,
        stateDefinitions,
        subComponentOptions,
        structure,
        resolvedExpressions
      )
      return elementNode

    case 'dynamic':
      const dynamicNode = await generateDynamicNode(
        node,
        compName,
        nodesLookup,
        propDefinitions,
        stateDefinitions,
        subComponentOptions,
        structure
      )
      return dynamicNode

    case 'conditional':
      const conditionalNodeComment = HASTBuilders.createComment(
        'Conditional nodes are not supported in HTML'
      )
      const {
        value: staticValue,
        reference,
        condition: { conditions, matchingCriteria },
      } = node.content

      if (reference.type !== 'dynamic') {
        return conditionalNodeComment
      }

      const {
        content: { referenceType, id, refPath = [] },
      } = reference

      switch (referenceType) {
        case 'prop': {
          const usedProp = propDefinitions[id]
          if (usedProp === undefined || usedProp.defaultValue === undefined) {
            return conditionalNodeComment
          }

          let defaultValue = usedProp.defaultValue
          for (const path of refPath) {
            defaultValue = (defaultValue as Record<string, unknown[]>)?.[path]
          }

          // Safety measure in case no value is found
          if (!defaultValue) {
            defaultValue = usedProp.defaultValue
          }

          // Since we know the operand and the default value from the prop.
          // We can try building the condition and check if the condition is true or false.
          // @todo: You can only use a 'value' in UIDL or 'conditions' but not both.
          // UIDL validations need to be improved on this aspect.
          const dynamicConditions = createConditionalStatement(
            staticValue !== undefined ? [{ operand: staticValue, operation: '===' }] : conditions,
            defaultValue
          )
          const matchCondition = matchingCriteria && matchingCriteria === 'all' ? '&&' : '||'
          const conditionString = dynamicConditions.join(` ${matchCondition} `)

          try {
            // tslint:disable-next-line function-constructor
            const isConditionPassing = new Function(`return ${conditionString}`)()
            if (isConditionPassing) {
              return generateHtmlSyntax(
                node.content.node,
                compName,
                nodesLookup,
                propDefinitions,
                stateDefinitions,
                subComponentOptions,
                structure,
                resolvedExpressions
              )
            }
          } catch (error) {
            return conditionalNodeComment
          }

          return conditionalNodeComment
        }

        case 'state':
        default:
          return conditionalNodeComment
      }

    case 'expr':
      const content = node.content.split('?.')

      if (resolvedExpressions && resolvedExpressions.expressions?.[content[0] || '']) {
        const uidlDynamicRef: UIDLDynamicReference = {
          type: 'dynamic',
          content: {
            referenceType: 'prop',
            refPath: [resolvedExpressions.currentIndex.toString(), ...content.slice(1)],
            id: content[0],
          },
        }
        const generatedNode = await generateDynamicNode(
          uidlDynamicRef,
          compName,
          nodesLookup,
          resolvedExpressions.expressions,
          stateDefinitions,
          subComponentOptions,
          structure
        )
        return generatedNode
      }

      return HASTBuilders.createComment('Expressions are not supported in HTML')
    case 'cms-list-repeater':
      return generateRepeaterNode(
        node,
        compName,
        nodesLookup,
        propDefinitions,
        stateDefinitions,
        subComponentOptions,
        structure
      )
    default:
      throw new HTMLComponentGeneratorError(
        `generateHtmlSyntax encountered a node of unsupported type: ${JSON.stringify(
          node,
          null,
          2
        )} `
      )
  }
}

const createConditionalStatement = (
  conditions: UIDLConditionalNode['content']['condition']['conditions'],
  leftOperand: UIDLPropDefinition['defaultValue']
) => {
  return conditions.map((condition) => {
    const { operation, operand } = condition

    if (operand === undefined) {
      return `${ASTUtils.convertToUnaryOperator(operation)}${getValueType(operand)}`
    }

    return `${getValueType(leftOperand)} ${ASTUtils.convertToBinaryOperator(
      operation
    )} ${getValueType(operand)}`
  })
}

const getValueType = (value: UIDLPropDefinition['defaultValue']) => {
  const valueType = typeof value
  switch (valueType) {
    case 'string':
      return `"${value}"`
    case 'number':
      return value
    case 'boolean':
      return value
    default:
      throw new HTMLComponentGeneratorError(
        `Conditional node received an operand of type ${valueType} \n
          Received ${JSON.stringify(value)}`
      )
  }
}

const generateRepeaterNode: NodeToHTML<
  UIDLCMSListRepeaterNode,
  Promise<HastNode | HastText>
> = async (
  node,
  compName,
  nodesLookup,
  propDefinitions,
  stateDefinitions,
  subComponentOptions,
  structure
) => {
  const { nodes } = node.content

  const contextId = node.content.renderPropIdentifier
  const sourceValue = node.content.source
  let propDef =
    propDefinitions[
      Object.keys(propDefinitions).find((propKey) => sourceValue.includes(propKey)) || ''
    ]

  if (!propDef || !Array.isArray(propDef.defaultValue)) {
    // If no prop is found we might have a static source value
    try {
      const parsedSource = JSON.parse(sourceValue)
      propDef = {
        defaultValue: parsedSource,
        id: contextId,
        type: 'array',
      }
    } catch {
      // Silent fail
    }
  }

  // We do the check again to keep typescript happy, otherwise this could be in catch
  if (!propDef || !Array.isArray(propDef.defaultValue)) {
    return HASTBuilders.createComment(
      'CMS Array Mapper/Repeater not supported in HTML without a prop source'
    )
  }
  propDefinitions[contextId] = propDef

  const elementNode = HASTBuilders.createHTMLNode('div')
  node.content.nodes.list.content.style = { display: { type: 'static', content: 'contents' } }
  if (node.content.nodes.empty) {
    node.content.nodes.empty.content.style = { display: { type: 'static', content: 'contents' } }
  }
  // Empty case
  if (propDef.defaultValue.length === 0) {
    const emptyChildren = nodes.empty.content.children
    if (emptyChildren) {
      for (const child of emptyChildren) {
        const childTag = await generateHtmlSyntax(
          child,
          compName,
          nodesLookup,
          propDefinitions,
          stateDefinitions,
          subComponentOptions,
          structure
        )

        if (typeof childTag === 'string') {
          HASTUtils.addTextNode(elementNode, childTag)
        } else {
          HASTUtils.addChildNode(elementNode, childTag as HastNode)
        }
      }
    }

    addNodeToLookup(`${node.content.nodes.empty.content.key}`, elementNode, nodesLookup)
    return elementNode
  }

  const listChildren = nodes.list.content.children
  if (listChildren) {
    for (let index = 0; index < propDef.defaultValue.length; index++) {
      for (const child of listChildren) {
        const childTag = await generateHtmlSyntax(
          child,
          compName,
          nodesLookup,
          propDefinitions,
          stateDefinitions,
          subComponentOptions,
          structure,
          { currentIndex: index, expressions: { [contextId]: propDef } }
        )

        if (typeof childTag === 'string') {
          HASTUtils.addTextNode(elementNode, childTag)
        } else {
          HASTUtils.addChildNode(elementNode, childTag as HastNode)
        }
      }
    }
  }

  addNodeToLookup(`${node.content.nodes.list.content.key}`, elementNode, nodesLookup)
  return elementNode
}

const generateElementNode: NodeToHTML<
  UIDLElementNode,
  Promise<HastNode | HastText | Array<HastNode | HastText>>
> = async (
  node,
  compName,
  nodesLookup,
  propDefinitions,
  stateDefinitions,
  subComponentOptions,
  structure,
  resolvedExpressions
) => {
  const {
    elementType,
    children,
    attrs = {},
    style = {},
    referencedStyles = {},
    dependency,
  } = node.content
  const { dependencies } = structure
  if (dependency && (dependency as UIDLDependency)?.type === 'local') {
    const compTag = await generateComponentContent(
      node,
      nodesLookup,
      propDefinitions,
      stateDefinitions,
      subComponentOptions,
      structure
    )

    if ('tagName' in compTag) {
      compTag.children.unshift(HASTBuilders.createComment(`${node.content.semanticType} component`))
    }

    return compTag
  }

  if (dependency && (dependency as UIDLDependency)?.type !== 'local') {
    dependencies[dependency.path] = dependency
  }

  const elementNode = HASTBuilders.createHTMLNode(elementType)

  if (children) {
    for (const child of children) {
      const childTag = await generateHtmlSyntax(
        child,
        compName,
        nodesLookup,
        propDefinitions,
        stateDefinitions,
        subComponentOptions,
        structure,
        resolvedExpressions
      )

      if (typeof childTag === 'string') {
        HASTUtils.addTextNode(elementNode, childTag)
      } else {
        HASTUtils.addChildNode(elementNode, childTag as HastNode)
      }
    }
  }

  if (Object.keys(referencedStyles).length > 0) {
    Object.keys(referencedStyles).forEach((styleRef) => {
      const refStyle = referencedStyles[styleRef]
      if (refStyle.content.mapType === 'inlined') {
        handleStyles(node, refStyle.content.styles, propDefinitions, stateDefinitions)
      }
    })
  }

  if (Object.keys(style).length > 0) {
    handleStyles(node, style, propDefinitions, stateDefinitions)
  }

  handleAttributes(
    elementType,
    elementNode,
    attrs,
    propDefinitions,
    stateDefinitions,
    structure.options.projectRouteDefinition,
    structure.outputOptions,
    resolvedExpressions?.currentIndex
  )

  addNodeToLookup(node.content.key, elementNode, nodesLookup)
  return elementNode
}

const createLookupTable = (
  component: ComponentUIDL,
  nodesLookup: Record<string, HastNode | HastText | Array<HastNode | HastText>>
): ElementsLookup => {
  const lookup: ElementsLookup = {}
  for (const node of Object.keys(nodesLookup)) {
    lookup[node] = {
      count: 1,
      nextKey: '1',
    }
  }
  createNodesLookup(component, lookup)
  return lookup
}

const generateComponentContent = async (
  node: UIDLElementNode,
  nodesLookup: Record<string, HastNode | HastText | Array<HastNode | HastText>>,
  propDefinitions: Record<string, UIDLPropDefinition>,
  stateDefinitions: Record<string, UIDLStateDefinition>,
  subComponentOptions: {
    externals: Record<string, ComponentUIDL>
    plugins: ComponentPlugin[]
  },
  structure: {
    chunks: ChunkDefinition[]
    dependencies: Record<string, UIDLDependency>
    options: GeneratorOptions
    outputOptions: UIDLComponentOutputOptions
  }
) => {
  const { externals, plugins } = subComponentOptions
  const { elementType, attrs = {}, children = [] } = node.content
  const { dependencies, chunks = [], options } = structure
  // "Component" will not exist when generating a component because the resolver checks for illegal class names
  const componentName = elementType === 'Component' ? 'AppComponent' : elementType
  const component = externals[componentName]
  if (component === undefined) {
    throw new HTMLComponentGeneratorError(`${componentName} is missing from externals object`)
  }

  const componentClone = UIDLUtils.cloneObject<ComponentUIDL>(component)

  if (children.length) {
    UIDLUtils.traverseNodes(componentClone.node, (childNode, parentNode) => {
      if (childNode.type === 'slot' && parentNode.type === 'element') {
        const nonSlotNodes = parentNode.content?.children?.filter((n) => n.type !== 'slot')
        parentNode.content.children = [
          ...nonSlotNodes,
          {
            type: 'element',
            content: {
              key: 'custom-slot',
              elementType: 'slot',
              name: componentClone.name + 'slot',
              style: {
                display: {
                  type: 'static',
                  content: 'contents',
                },
              },
              children,
            },
          },
        ]
      }
    })
    /*
      Since we don't generate direct component children in HTML. We need to reset this,
      or else the plugins like css and others try to parse and process them.
    */
    node.content.children = []
  }

  // In UIDL, we define only the link between a component and a page.
  // We define this link using the UIDLLocalDependency approach.
  // So, during the page resolution step, where we ideally generate the unique keys for the components.
  // We can't generate the unique keys for the components because we don't have the full UIDL of the component.
  // When we are using components in a page, the `addExternalComponents` step of the
  // html-component-generator will add the full UIDL of the component to the externals object after resolving them.
  // But when a component is used multiple number of times, we are basically using the same nodes again and again.
  // Which indivates duplication. So, we create a lookup table of all the nodes present with us in the page
  // And then pass it to the component to avoid any coilissions.
  const lookupTableForCurrentPage = createLookupTable(componentClone, nodesLookup)
  generateUniqueKeys(componentClone, lookupTableForCurrentPage)

  // We are combining props of the current component
  // with props of the component that we need to generate.
  // Refer to line 309, for element props. We either pick from the attr of the current instance of component
  // or from the propDefinitions of the component that we are generating.
  // We don't need to keep passing the props of the current component to the child component and so on
  // for the case of element nodes in attributes or propDefinitions.
  const combinedProps: Record<string, UIDLPropDefinition> = {
    ...Object.keys(propDefinitions).reduce<Record<string, UIDLPropDefinition>>(
      (acc: Record<string, UIDLPropDefinition>, propKey) => {
        if (propDefinitions[propKey]?.type === 'element') {
          return acc
        }
        acc[propKey] = propDefinitions[propKey]
        return acc
      },
      {}
    ),
    ...(componentClone?.propDefinitions || {}),
  }
  const combinedStates = { ...stateDefinitions, ...(componentClone?.stateDefinitions || {}) }
  const statesForInstance = Object.keys(combinedStates).reduce(
    (acc: Record<string, UIDLStateDefinition>, propKey) => {
      const attr = attrs[propKey]

      if (attr?.type === 'object') {
        throw new Error(`Object attributes are not supported in html exports`)
      }

      if (attr) {
        acc[propKey] = {
          ...combinedStates[propKey],
          defaultValue: attr?.content || combinedStates[propKey]?.defaultValue,
        }
      } else {
        acc[propKey] = combinedStates[propKey]
      }

      return acc
    },
    {}
  )

  const propsForInstance: Record<string, UIDLPropDefinition> = {}
  // this is where we check if the component we are conusming is actually passing any props to the instance.
  // We check if we are passing any props and pick the value from the atrrs, if not we pick the value from the propDefinitions of
  // the component instance that we are using here.
  for (const propKey of Object.keys(combinedProps)) {
    const attribute = attrs[propKey]

    if (attribute?.type === 'element') {
      propsForInstance[propKey] = {
        ...combinedProps[propKey],
        defaultValue: attrs[propKey],
      }
      await generateHtmlSyntax(
        attrs[propKey] as UIDLElementNode,
        component.name,
        nodesLookup,
        propDefinitions,
        stateDefinitions,
        subComponentOptions,
        structure
      )
    }

    if (attribute?.type === 'dynamic') {
      // When we are using a component instance in a component and the attribute
      // that is passed to the component is of dynamic reference.
      // If means, the component is redirecting the prop that is received to the prop of the component that it is consuming.
      // In this case, we need to pass the value of the prop that is received to the prop of the component that it is consuming.
      // And similary we do the same for the states.
      switch (attribute.content.referenceType) {
        case 'prop':
          propsForInstance[propKey] = combinedProps[propKey]
          break
        case 'state':
          propsForInstance[propKey] = combinedStates[propKey]
          break
        case 'expr':
          // Ignore expr type attributes in html comp instances for the time being.
          break
        default:
          throw new Error(
            `ReferenceType ${attribute.content.referenceType} is not supported in HTML Export.`
          )
      }
    }

    if (attribute?.type === 'object') {
      propsForInstance[propKey] = {
        ...combinedProps[propKey],
        defaultValue: (attribute?.content as object) || combinedProps[propKey]?.defaultValue,
      }
    }

    if (
      attribute?.type !== 'dynamic' &&
      attribute?.type !== 'element' &&
      attribute?.type !== 'object'
    ) {
      propsForInstance[propKey] = {
        ...combinedProps[propKey],
        defaultValue: attribute?.content || combinedProps[propKey]?.defaultValue,
      }
    }

    if (attribute === undefined) {
      const propFromCurrentComponent = combinedProps[propKey]
      if (propFromCurrentComponent.type === 'element' && propFromCurrentComponent.defaultValue) {
        await generateHtmlSyntax(
          propFromCurrentComponent.defaultValue as UIDLElementNode,
          component.name,
          nodesLookup,
          propDefinitions,
          stateDefinitions,
          subComponentOptions,
          structure
        )
      }
      propsForInstance[propKey] = propFromCurrentComponent
    }
  }

  let componentWrapper = StringUtils.camelCaseToDashCase(`${componentName}-wrapper`)
  const isExistingNode = nodesLookup[componentWrapper]
  if (isExistingNode !== undefined) {
    componentWrapper = `${componentWrapper}-${StringUtils.generateRandomString()}`
  }

  const componentInstanceToGenerate: UIDLElementNode = {
    type: 'element',
    content: {
      elementType: componentWrapper,
      key: componentWrapper,
      children: [componentClone.node],
      style: {
        display: {
          type: 'static',
          content: 'contents',
        },
      },
    },
  }

  const compTag = await generateHtmlSyntax(
    componentInstanceToGenerate,
    component.name,
    nodesLookup,
    propsForInstance,
    statesForInstance,
    subComponentOptions,
    structure
  )

  const cssPlugin = createCSSPlugin({
    templateStyle: 'html',
    templateChunkName: DEFAULT_COMPONENT_CHUNK_NAME,
    declareDependency: 'import',
    chunkName: componentClone.name,
    staticPropReferences: true,
  })

  const initialStructure: ComponentStructure = {
    uidl: {
      ...componentClone,
      node: componentInstanceToGenerate,
      propDefinitions: propsForInstance,
      stateDefinitions: statesForInstance,
    },
    chunks: [
      {
        type: ChunkType.HAST,
        fileType: FileType.HTML,
        name: DEFAULT_COMPONENT_CHUNK_NAME,
        linkAfter: [],
        content: compTag,
        meta: {
          nodesLookup,
        },
      },
    ],
    dependencies,
    options,
  }

  const result = await [cssPlugin, ...plugins].reduce(
    async (previousPluginOperation: Promise<ComponentStructure>, plugin) => {
      const modifiedStructure = await previousPluginOperation
      return plugin(modifiedStructure)
    },
    Promise.resolve(initialStructure)
  )

  result.chunks.forEach((chunk) => {
    if (chunk.fileType === FileType.CSS) {
      chunks.push(chunk)
    }
  })

  addNodeToLookup(node.content.key, compTag, nodesLookup)
  return compTag
}

const generateDynamicNode: NodeToHTML<
  UIDLDynamicReference,
  Promise<HastNode | HastText | Array<HastNode | HastText>>
> = async (
  node,
  compName,
  nodesLookup,
  propDefinitions,
  stateDefinitions,
  subComponentOptions,
  structure
): Promise<HastNode | HastText | Array<HastNode | HastText>> => {
  if (node.content.referenceType === 'locale') {
    const localeTag = HASTBuilders.createHTMLNode('span')
    const commentNode = HASTBuilders.createComment(`Content for locale ${node.content.id}`)
    HASTUtils.addChildNode(localeTag, commentNode)
    return localeTag
  }

  const usedReferenceValue = getValueFromReference(
    node.content.id,
    node.content.referenceType === 'prop' ? propDefinitions : stateDefinitions
  )

  if (
    (usedReferenceValue.type === 'object' || usedReferenceValue.type === 'array') &&
    usedReferenceValue.defaultValue
  ) {
    // Let's say users are biding the prop to a node using something like this "fields.Title"
    // But the fields in the object is the value where the object is defined either in propDefinitions
    // or on the attrs. So, we just need to parsed the rest of the object path and get the value from the object.
    return HASTBuilders.createTextNode(
      String(
        extractDefaultValueFromRefPath(
          usedReferenceValue.defaultValue as Record<string, UIDLPropDefinition>,
          node.content.refPath
        )
      )
    )
  }

  if (usedReferenceValue.type === 'element') {
    const elementNode = usedReferenceValue.defaultValue as UIDLElementNode
    if (elementNode) {
      if (elementNode.content.key in nodesLookup) {
        return nodesLookup[elementNode.content.key]
      } else {
        const elementTag = await generateHtmlSyntax(
          elementNode,
          compName,
          nodesLookup,
          propDefinitions,
          stateDefinitions,
          subComponentOptions,
          structure
        )
        return elementTag
      }
    }

    const spanTagWrapper = HASTBuilders.createHTMLNode('span')
    const commentNode = HASTBuilders.createComment(`Content for slot ${node.content.id}`)
    HASTUtils.addChildNode(spanTagWrapper, commentNode)
    return spanTagWrapper
  }

  const spanTag = HASTBuilders.createHTMLNode('span')
  HASTUtils.addTextNode(spanTag, String(usedReferenceValue.defaultValue))
  return spanTag
}

const handleStyles = (
  node: UIDLElementNode,
  styles: UIDLStyleDefinitions,
  propDefinitions: Record<string, UIDLPropDefinition>,
  stateDefinitions: Record<string, UIDLStateDefinition>
) => {
  Object.keys(styles).forEach((styleKey) => {
    let style: string | UIDLStyleValue = styles[styleKey]
    if (style.type === 'dynamic' && style.content?.referenceType !== 'token') {
      const referencedValue = getValueFromReference(
        style.content.id,
        style.content.referenceType === 'prop' ? propDefinitions : stateDefinitions
      )
      if (referencedValue.type === 'string' || referencedValue.type === 'number') {
        style = String(
          extractDefaultValueFromRefPath(referencedValue.defaultValue, style?.content?.refPath)
        )
      }
      node.content.style[styleKey] = typeof style === 'string' ? staticNode(style) : style
    }
  })
}

const handleAttributes = (
  elementType: UIDLElement['elementType'],
  htmlNode: HastNode,
  attrs: Record<string, UIDLAttributeValue>,
  propDefinitions: Record<string, UIDLPropDefinition>,
  stateDefinitions: Record<string, UIDLStateDefinition>,
  routeDefinitions: UIDLRouteDefinitions,
  outputOptions: UIDLComponentOutputOptions,
  currentIndex?: number
) => {
  for (const attrKey of Object.keys(attrs)) {
    const attrValue = attrs[attrKey]
    const { type, content } = attrValue

    switch (type) {
      case 'static': {
        if (attrKey === 'href' && typeof content === 'string' && content.startsWith('/')) {
          let targetLink

          const targetRoute = (routeDefinitions?.values || []).find(
            (route) => route.pageOptions.navLink === content
          )

          if (targetRoute) {
            targetLink = targetRoute.pageOptions.navLink
          }

          if (!targetRoute && content === '/home') {
            targetLink = '/'
          }

          if (!targetLink && !targetRoute) {
            targetLink = content
          }

          const currentPageRoute = join(...(outputOptions?.folderPath || []), './')
          const localPrefix = relative(
            `/${currentPageRoute}`,
            `/${targetLink === '/' ? 'index' : targetLink}`
          )

          HASTUtils.addAttributeToNode(htmlNode, attrKey, `${localPrefix}.html`)
          break
        }

        if (typeof content === 'boolean') {
          htmlNode.properties[attrKey] = content === true ? 'true' : 'false'
        } else if (typeof content === 'string' || typeof attrValue.content === 'number') {
          let value = StringUtils.encode(String(attrValue.content))

          /*
            elementType of image is always mapped to img.
            For reference, check `html-mapping` file.
          */
          if (elementType === 'img' && attrKey === 'src' && !isValidURL(value)) {
            /*
              By default we just prefix all the asset paths with just the
              assetPrefix that is configured in the project. But for `html` generators
              we need to prefix that with the current file location.

              Because, all the other frameworks have a build setup. which serves all the
              assets from the `public` folder. But in the case of `html` here is how it works

              We load a file from `index.html` the request for the image goes from
              '...url.../public/...image...'
              If it's a nested url, then the request goes from
              '...url/nested/public/...image..'

              But the nested folder is available only on the root. With this
              The url changes prefixes to

              ../public/playground_assets/..image.. etc depending on the dept the file is in.
            */
            value = join(relative(join(...outputOptions.folderPath), './'), value)
          }

          HASTUtils.addAttributeToNode(htmlNode, attrKey, value)
        }

        break
      }

      case 'dynamic': {
        const value = getValueFromReference(
          content.id,
          content.referenceType === 'prop' ? propDefinitions : stateDefinitions
        )

        HASTUtils.addAttributeToNode(
          htmlNode,
          attrKey,
          String(extractDefaultValueFromRefPath(value.defaultValue, content.refPath))
        )
        break
      }

      case 'raw': {
        HASTUtils.addAttributeToNode(htmlNode, attrKey, content)
        break
      }

      case 'expr': {
        const fullPath = content.split('?.')
        const prop = propDefinitions[fullPath?.[0] || '']

        if (!prop) {
          break
        }

        const path =
          typeof currentIndex === 'number'
            ? [currentIndex.toString(), ...fullPath.slice(1)]
            : fullPath.slice(1)
        const value = extractDefaultValueFromRefPath(prop.defaultValue, path)
        if (!value) {
          break
        }
        HASTUtils.addAttributeToNode(htmlNode, attrKey, String(value))
        break
      }

      case 'element':
      case 'import':
      case 'object':
        break

      default: {
        throw new HTMLComponentGeneratorError(
          `Received ${JSON.stringify(attrValue, null, 2)} \n in handleAttributes for html`
        )
      }
    }
  }
}

const getValueFromReference = (
  key: string,
  definitions: Record<string, UIDLPropDefinition>
): UIDLPropDefinition | undefined => {
  const usedReferenceValue = definitions[key.includes('?.') ? key.split('?.')[0] : key]

  if (!usedReferenceValue) {
    throw new HTMLComponentGeneratorError(
      `Definition for ${key} is missing from ${JSON.stringify(definitions, null, 2)}`
    )
  }

  if (
    ['string', 'number', 'object', 'element', 'array', 'boolean'].includes(
      usedReferenceValue?.type
    ) === false
  ) {
    throw new HTMLComponentGeneratorError(
      `Attribute is using dynamic value, but received of type ${JSON.stringify(
        usedReferenceValue,
        null,
        2
      )}`
    )
  }

  if (
    usedReferenceValue.type !== 'element' &&
    usedReferenceValue.hasOwnProperty('defaultValue') === false
  ) {
    throw new HTMLComponentGeneratorError(
      `Default value is missing from dynamic reference - ${JSON.stringify(
        usedReferenceValue,
        null,
        2
      )}`
    )
  }

  return usedReferenceValue
}

const extractDefaultValueFromRefPath = (
  propDefaultValue: PropDefaultValueTypes,
  refPath?: string[]
) => {
  if (typeof propDefaultValue !== 'object' || !refPath?.length) {
    return propDefaultValue
  }

  return GenericUtils.getValueFromPath(refPath.join('.'), propDefaultValue) as PropDefaultValueTypes
}
