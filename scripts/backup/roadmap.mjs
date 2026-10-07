const PAGE_SIZE = 100;
const MAX_PAGES = 10000;

const KNOWN_FIELD_VALUE_TYPES = new Set([
  'ProjectV2ItemFieldDateValue',
  'ProjectV2ItemFieldIterationValue',
  'ProjectV2ItemFieldLabelValue',
  'ProjectV2ItemFieldMilestoneValue',
  'ProjectV2ItemFieldMultiSelectValue',
  'ProjectV2ItemFieldNumberValue',
  'ProjectV2ItemFieldPullRequestValue',
  'ProjectV2ItemFieldRepositoryValue',
  'ProjectV2ItemFieldReviewerValue',
  'ProjectV2ItemFieldSingleSelectValue',
  'ProjectV2ItemFieldTextValue',
  'ProjectV2ItemFieldUserValue',
  'ProjectV2ItemIssueFieldValue',
]);

const KNOWN_CONTENT_TYPES = new Set(['Issue', 'PullRequest', 'DraftIssue']);
const ITEM_TYPE_CONTENT_TYPES = { ISSUE: 'Issue', PULL_REQUEST: 'PullRequest', DRAFT_ISSUE: 'DraftIssue' };
const KNOWN_ISSUE_FIELD_VALUE_TYPES = new Set([
  'IssueFieldDateValue',
  'IssueFieldMultiSelectValue',
  'IssueFieldNumberValue',
  'IssueFieldSingleSelectValue',
  'IssueFieldTextValue',
]);
const KNOWN_REVIEWER_TYPES = new Set(['User', 'Team', 'Bot', 'Mannequin', 'EnterpriseTeam']);

const ISSUES_QUERY = `query BackupIssues($owner: String!, $name: String!, $first: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issues(first: $first, after: $cursor) {
      nodes {
        id
        number
        title
        body
        state
        url
      }
      pageInfo {
        hasNextPage
        endCursor
      }
    }
  }
}`;

const COMMENTS_QUERY = `query BackupComments($owner: String!, $name: String!, $issueNumber: Int!, $first: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issue(number: $issueNumber) {
      comments(first: $first, after: $cursor) {
        nodes {
          id
          body
          createdAt
          author {
            login
          }
          url
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}`;

const LABELS_QUERY = `query BackupLabels($owner: String!, $name: String!, $issueNumber: Int!, $first: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issue(number: $issueNumber) {
      labels(first: $first, after: $cursor) {
        nodes {
          id
          name
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}`;

const BLOCKED_BY_QUERY = `query BackupBlockedBy($owner: String!, $name: String!, $issueNumber: Int!, $first: Int!, $cursor: String) {
  repository(owner: $owner, name: $name) {
    issue(number: $issueNumber) {
      blockedBy(first: $first, after: $cursor) {
        nodes {
          id
          number
          url
          repository {
            nameWithOwner
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}`;

const PARENT_QUERY = `query BackupParent($owner: String!, $name: String!, $issueNumber: Int!) {
  repository(owner: $owner, name: $name) {
    issue(number: $issueNumber) {
      parent {
        id
        number
        url
        repository {
          nameWithOwner
        }
      }
    }
  }
}`;

const FIELD_VALUE_FRAGMENT = `
        __typename
        ... on ProjectV2ItemFieldDateValue {
          id
          date
          field { ... on ProjectV2FieldCommon { id name } }
        }
        ... on ProjectV2ItemFieldIterationValue {
          id
          iterationId
          title
          startDate
          duration
          field { ... on ProjectV2FieldCommon { id name } }
        }
        ... on ProjectV2ItemFieldLabelValue {
          field { ... on ProjectV2FieldCommon { id name } }
        }
        ... on ProjectV2ItemFieldMilestoneValue {
          milestone { id number title url }
          field { ... on ProjectV2FieldCommon { id name } }
        }
        ... on ProjectV2ItemFieldMultiSelectValue {
          id
          value
          options { id name }
          field { ... on ProjectV2FieldCommon { id name } }
        }
        ... on ProjectV2ItemFieldNumberValue {
          id
          number
          field { ... on ProjectV2FieldCommon { id name } }
        }
        ... on ProjectV2ItemFieldPullRequestValue {
          field { ... on ProjectV2FieldCommon { id name } }
        }
        ... on ProjectV2ItemFieldRepositoryValue {
          repository { id nameWithOwner url }
          field { ... on ProjectV2FieldCommon { id name } }
        }
        ... on ProjectV2ItemFieldReviewerValue {
          field { ... on ProjectV2FieldCommon { id name } }
        }
        ... on ProjectV2ItemFieldSingleSelectValue {
          id
          name
          optionId
          color
          field { ... on ProjectV2FieldCommon { id name } }
        }
        ... on ProjectV2ItemFieldTextValue {
          id
          text
          field { ... on ProjectV2FieldCommon { id name } }
        }
        ... on ProjectV2ItemFieldUserValue {
          field { ... on ProjectV2FieldCommon { id name } }
        }
        ... on ProjectV2ItemIssueFieldValue {
          field { ... on ProjectV2FieldCommon { id name } }
          issueFieldValue {
            __typename
            ... on IssueFieldDateValue { id value }
            ... on IssueFieldMultiSelectValue { id value options { id name } }
            ... on IssueFieldNumberValue { id value }
            ... on IssueFieldSingleSelectValue { id name optionId value }
            ... on IssueFieldTextValue { id value }
          }
        }
`;

const FIELDS_QUERY = `query BackupFields($itemId: ID!, $first: Int!, $cursor: String) {
  node(id: $itemId) {
    ... on ProjectV2Item {
      fieldValues(first: $first, after: $cursor) {
        nodes {
${FIELD_VALUE_FRAGMENT}
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}`;

const FIELD_LABELS_QUERY = `query BackupFieldLabels($itemId: ID!, $fieldName: String!, $first: Int!, $cursor: String) {
  node(id: $itemId) {
    ... on ProjectV2Item {
      fieldValueByName(name: $fieldName) {
        ... on ProjectV2ItemFieldLabelValue {
          labels(first: $first, after: $cursor) {
            nodes { id name }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
  }
}`;

const FIELD_USERS_QUERY = `query BackupFieldUsers($itemId: ID!, $fieldName: String!, $first: Int!, $cursor: String) {
  node(id: $itemId) {
    ... on ProjectV2Item {
      fieldValueByName(name: $fieldName) {
        ... on ProjectV2ItemFieldUserValue {
          users(first: $first, after: $cursor) {
            nodes { id login }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
  }
}`;

const FIELD_PULL_REQUESTS_QUERY = `query BackupFieldPullRequests($itemId: ID!, $fieldName: String!, $first: Int!, $cursor: String) {
  node(id: $itemId) {
    ... on ProjectV2Item {
      fieldValueByName(name: $fieldName) {
        ... on ProjectV2ItemFieldPullRequestValue {
          pullRequests(first: $first, after: $cursor) {
            nodes { id number url }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
  }
}`;

const FIELD_REVIEWERS_QUERY = `query BackupFieldReviewers($itemId: ID!, $fieldName: String!, $first: Int!, $cursor: String) {
  node(id: $itemId) {
    ... on ProjectV2Item {
      fieldValueByName(name: $fieldName) {
        ... on ProjectV2ItemFieldReviewerValue {
          reviewers(first: $first, after: $cursor) {
            nodes {
              __typename
              ... on User { id login }
              ... on Team { id name slug }
              ... on Bot { id login }
              ... on Mannequin { id login }
              ... on EnterpriseTeam { id name slug }
            }
            pageInfo { hasNextPage endCursor }
          }
        }
      }
    }
  }
}`;

function getPath(data, pathParts) {
  return pathParts.reduce((node, key) => (node == null ? undefined : node[key]), data);
}

async function pageAll(gate, { query, variables, connectionPath, operationName }) {
  const nodes = [];
  let cursor = null;

  for (let page = 1; page <= MAX_PAGES; page += 1) {
    const result = await gate.read({
      query,
      variables: { ...variables, first: PAGE_SIZE, cursor },
      requireComplete: false,
    });

    if (!result.ok) {
      throw new Error(`Roadmap gate refused ${operationName}: ${result.code}`);
    }
    if (!result.data) {
      throw new Error(`Roadmap ${operationName} response missing data`);
    }

    const unexpectedIncomplete = (result.incomplete || []).filter((path) => path !== connectionPath);
    if (unexpectedIncomplete.length > 0) {
      throw new Error(
        `Roadmap ${operationName} unexpected truncated nested connection: ${unexpectedIncomplete.join(', ')}`,
      );
    }

    const connection = getPath(result.data, connectionPath.split('.'));
    if (
      !connection ||
      !Array.isArray(connection.nodes) ||
      !connection.pageInfo ||
      typeof connection.pageInfo.hasNextPage !== 'boolean'
    ) {
      throw new Error(`Roadmap ${operationName} malformed connection`);
    }

    nodes.push(...connection.nodes);

    if (!connection.pageInfo.hasNextPage) {
      return nodes;
    }

    const nextCursor = connection.pageInfo.endCursor;
    if (nextCursor == null || nextCursor === '' || nextCursor === cursor) {
      throw new Error(`Roadmap ${operationName} missing or repeated cursor`);
    }
    cursor = nextCursor;
  }

  throw new Error(`Roadmap ${operationName} exceeded ${MAX_PAGES} pages`);
}

async function readParent(gate, config, issueNumber) {
  const result = await gate.read({
    query: PARENT_QUERY,
    variables: {
      owner: config.repository.owner,
      name: config.repository.name,
      issueNumber,
    },
    requireComplete: false,
  });

  if (!result.ok) {
    throw new Error(`Roadmap gate refused BackupParent: ${result.code}`);
  }
  if (!result.data) {
    throw new Error('Roadmap BackupParent response missing data');
  }
  if ((result.incomplete || []).length > 0) {
    throw new Error('Roadmap BackupParent unexpected truncated');
  }

  const issue = getPath(result.data, ['repository', 'issue']);
  if (!issue || !('parent' in issue)) {
    throw new Error('Roadmap BackupParent missing parent field');
  }
  return issue.parent;
}

function itemsQuery(ownerType) {
  const ownerField = ownerType === 'organization' ? 'organization(login: $login)' : 'user(login: $login)';
  return `query BackupItems($login: String!, $number: Int!, $first: Int!, $cursor: String) {
  ${ownerField} {
    projectV2(number: $number) {
      items(first: $first, after: $cursor) {
        nodes {
          id
          type
          isArchived
          content {
            __typename
            ... on Issue { id number title body state url repository { nameWithOwner } }
            ... on PullRequest { id number title body state url repository { nameWithOwner } }
            ... on DraftIssue { id title body }
          }
        }
        pageInfo {
          hasNextPage
          endCursor
        }
      }
    }
  }
}`;
}

export async function exportRoadmap({ gate, config }) {
  const { owner, name } = config.repository;
  const projectOwner = config.project.owner;
  const projectNumber = config.project.number;
  const projectOwnerType = config.project.ownerType === 'organization' ? 'organization' : 'user';

  const issueNodes = await pageAll(gate, {
    query: ISSUES_QUERY,
    variables: { owner, name },
    connectionPath: 'repository.issues',
    operationName: 'BackupIssues',
  });

  const issues = [];
  for (const issueNode of issueNodes) {
    if (!issueNode || typeof issueNode !== 'object' || !Number.isInteger(issueNode.number)) {
      throw new Error('Roadmap BackupIssues malformed issue node');
    }

    const issueNumber = issueNode.number;
    const comments = await pageAll(gate, {
      query: COMMENTS_QUERY,
      variables: { owner, name, issueNumber },
      connectionPath: 'repository.issue.comments',
      operationName: 'BackupComments',
    });
    const labels = await pageAll(gate, {
      query: LABELS_QUERY,
      variables: { owner, name, issueNumber },
      connectionPath: 'repository.issue.labels',
      operationName: 'BackupLabels',
    });
    const blockedBy = await pageAll(gate, {
      query: BLOCKED_BY_QUERY,
      variables: { owner, name, issueNumber },
      connectionPath: 'repository.issue.blockedBy',
      operationName: 'BackupBlockedBy',
    });
    const parent = await readParent(gate, config, issueNumber);

    issues.push({
      id: issueNode.id,
      number: issueNode.number,
      title: issueNode.title,
      body: issueNode.body,
      state: issueNode.state,
      url: issueNode.url,
      comments,
      labels,
      blockedBy,
      parent,
    });
  }

  const itemsQueryString = itemsQuery(projectOwnerType);
  const itemNodes = await pageAll(gate, {
    query: itemsQueryString,
    variables: { login: projectOwner, number: projectNumber },
    connectionPath: projectOwnerType === 'organization' ? 'organization.projectV2.items' : 'user.projectV2.items',
    operationName: 'BackupItems',
  });

  const items = [];
  for (const itemNode of itemNodes) {
    if (!itemNode || typeof itemNode !== 'object' || typeof itemNode.id !== 'string') {
      throw new Error('Roadmap BackupItems malformed item');
    }

    const content = itemNode.content;
    const contentType = content?.__typename ?? ITEM_TYPE_CONTENT_TYPES[itemNode.type];
    if (content && contentType && !KNOWN_CONTENT_TYPES.has(contentType)) {
      throw new Error('Unsupported project item content type');
    }
    if (content && itemNode.type && !KNOWN_CONTENT_TYPES.has(ITEM_TYPE_CONTENT_TYPES[itemNode.type])) {
      throw new Error('Unsupported project item type');
    }
    if (content && !contentType && !itemNode.type) {
      throw new Error('Missing project item type');
    }

    const itemId = itemNode.id;
    const fieldValuesRaw = await pageAll(gate, {
      query: FIELDS_QUERY,
      variables: { itemId },
      connectionPath: 'node.fieldValues',
      operationName: 'BackupFields',
    });

    const fieldValues = [];
    for (const rawFieldValue of fieldValuesRaw) {
      if (!rawFieldValue || typeof rawFieldValue !== 'object' || !rawFieldValue.__typename) {
        throw new Error('Roadmap BackupFields value missing __typename');
      }
      if (!KNOWN_FIELD_VALUE_TYPES.has(rawFieldValue.__typename)) {
        throw new Error(`Unsupported project field value type: ${rawFieldValue.__typename}`);
      }

      const fieldValue = { ...rawFieldValue };
      const fieldName = rawFieldValue.field?.name;
      if (!fieldName) {
        throw new Error('Roadmap BackupFields value missing field name');
      }

      if (rawFieldValue.__typename === 'ProjectV2ItemFieldLabelValue') {
        fieldValue.labels = await pageAll(gate, {
          query: FIELD_LABELS_QUERY,
          variables: { itemId, fieldName },
          connectionPath: 'node.fieldValueByName.labels',
          operationName: 'BackupFieldLabels',
        });
      } else if (rawFieldValue.__typename === 'ProjectV2ItemFieldUserValue') {
        fieldValue.users = await pageAll(gate, {
          query: FIELD_USERS_QUERY,
          variables: { itemId, fieldName },
          connectionPath: 'node.fieldValueByName.users',
          operationName: 'BackupFieldUsers',
        });
      } else if (rawFieldValue.__typename === 'ProjectV2ItemFieldPullRequestValue') {
        fieldValue.pullRequests = await pageAll(gate, {
          query: FIELD_PULL_REQUESTS_QUERY,
          variables: { itemId, fieldName },
          connectionPath: 'node.fieldValueByName.pullRequests',
          operationName: 'BackupFieldPullRequests',
        });
      } else if (rawFieldValue.__typename === 'ProjectV2ItemFieldReviewerValue') {
        fieldValue.reviewers = await pageAll(gate, {
          query: FIELD_REVIEWERS_QUERY,
          variables: { itemId, fieldName },
          connectionPath: 'node.fieldValueByName.reviewers',
          operationName: 'BackupFieldReviewers',
        });
        for (const reviewer of fieldValue.reviewers) {
          if (!reviewer || !reviewer.__typename || !KNOWN_REVIEWER_TYPES.has(reviewer.__typename)) {
            throw new Error(`Unsupported reviewer type: ${reviewer?.__typename}`);
          }
        }
      } else if (rawFieldValue.__typename === 'ProjectV2ItemIssueFieldValue') {
        const inner = rawFieldValue.issueFieldValue;
        if (inner && !KNOWN_ISSUE_FIELD_VALUE_TYPES.has(inner.__typename)) {
          throw new Error(`Unsupported issue field value type: ${inner.__typename}`);
        }
      }

      fieldValues.push(fieldValue);
    }

    items.push({
      id: itemNode.id,
      type: itemNode.type,
      isArchived: itemNode.isArchived,
      content: itemNode.content,
      fieldValues,
    });
  }

  return {
    repository: `${owner}/${name}`,
    issues,
    project: {
      number: projectNumber,
      items,
    },
    complete: true,
  };
}
